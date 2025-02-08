import express from "express"
import multer from "multer"
import ffmpeg, { FfmpegCommand } from "fluent-ffmpeg"
import * as dotenv from "dotenv"
import { Client } from "pg"
import { URLSearchParams } from "url"
import { JWTPayload, jwtVerify, SignJWT } from "jose"
import cookieParser from "cookie-parser"
import { randomUUID } from "crypto"

const app = express()
app.use(cookieParser())
app.set("view engine", "ejs")
dotenv.config()
const upload = multer({
    dest: "uploads/"
})
const db = new Client({
    host: process.env.DATABASE_HOST || "localhost",
    port: parseInt(process.env.DATABASE_PORT || "5432"),
    user: process.env.DATABASE_USER || "postgres",
    password: process.env.DATABASE_PASSWORD || "postgres",
    database: process.env.DATABASE_NAME || "mydatabase",
})

interface Upload {
    file: string,
    duration: number,
    progress: number,
    video: FfmpegCommand
}
interface Uploads {
    [key: number]: Upload
}

const uploads: Uploads = {}

db.connect()
    .catch(e => console.log(`There was a problem connecting to the database: ${e}`))

app.use(express.json())

function getFileName(fileName: string): string | null {
    const match = fileName.match(new RegExp("([0-9])+|.mp4", "g"))
    if (!match || match.length != 8) {
        return null
    } else {
        return match.slice(0, 3).join(".") + "-" + match.slice(3, 7).join(".") + match[7]
    }
}

function videoSave(video: FfmpegCommand, upload: Upload): Promise<void> {
    return new Promise((resolve, reject) => {
        video.save("processed/" + upload.file).on("error", e => {
            reject(e.message)
        }).on("end", _ => {
            upload.progress = 100.00
            resolve()
        }).on("progress", p => {
            if (p.timemark != "N/A") {
                let times = p.timemark.split(".")[0].split(":").map(Number)
                let timeInSeconds = times[0] * 3600 + times[1] * 60 + times[2]
                upload.progress = (timeInSeconds / upload.duration * 100)
            }
        })
    })
}

function videoThumbnail(video: FfmpegCommand, fileName: string): Promise<void> {
    return new Promise((resolve, reject) => {
        video.screenshot({ count: 1, timestamps: [0], filename: fileName, folder: "thumbnails" }).on("error", e => reject(e.message)).on("end", _ => resolve())
    })
}

app.get("/raw/:clip", (req, res) => {
    db.query("SELECT * FROM uploads WHERE id = $1", [req.params.clip]).then(data => data.rows).then(data => {
        if (data[0].finished) res.sendFile(`${process.cwd()}/processed/${data[0].file}`)
        else res.status(403).json({})
    }).catch(_ => res.status(403).json({}))
})

app.get("/thumbnail/:clip", (req, res) => {
    db.query("SELECT * FROM uploads WHERE id = $1", [req.params.clip]).then(data => data.rows).then(data => {
        if (data[0].finished) res.sendFile(`${process.cwd()}/thumbnails/${data[0].id}.png`)
        else res.status(403).json({})
    }).catch(_ => res.status(403).json({}))
})

app.get("/clips/:clip", (req, res) => {
    if (!req.cookies.tk) res.status(401).json({ message: "Unauthorized use of this service" })
    else {
        Promise.all([jwtVerify(req.cookies.tk, new TextEncoder().encode(process.env.JWT_SECRET)), db.query("SELECT uploads.*,users.username FROM uploads uploads JOIN users users ON uploads.owner = users.id WHERE uploads.id = $1", [req.params.clip])])
            .then(res => [res[0].payload, res[1].rows] as [JWTPayload, any[]])
            .then(([payload, data]) => {
                if (data.length > 0 && (data[0].visible || payload.username == data[0].username)) {
                    if (data[0].finished) res.render(`${process.cwd()}/views/clip.ejs`, {
                        clipData: data[0]
                    })
                    else res.status(403).json({ message: "This video is still processing" })
                } else throw new Error(undefined)
            })
            .catch(_ => {
                if (!res.headersSent) res.status(401).json({ message: "Unauthorized use of this service" })
            })

    }
})

app.get("/", (req, res) => {
    if (!req.cookies.tk) res.redirect(`https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&response_type=code&redirect_uri=${process.env.DISCORD_REDIRECT_URL}&scope=identify`)
    else {
        let filterQuery = ""
        if (req.query.filter) {
            if (req.query.filter == "processing") filterQuery = " AND finished = false"
            if (req.query.filter == "processed") filterQuery = " AND finished = true"
            if (req.query.filter == "public") filterQuery = " AND visible = true"
            if (req.query.filter == "private") filterQuery = " AND finished = false"
        }
        jwtVerify(req.cookies.tk, new TextEncoder().encode(process.env.JWT_SECRET))
            .then(res => res.payload)
            .then(data => db.query(`SELECT id,title,finished,visible FROM uploads WHERE owner = $1${filterQuery};`, [data.id]))
            .then(data => data.rows)
            .then(data => {
                res.render(`${process.cwd()}/views/list.ejs`, {
                    uploads: data.map(row => `<tr><th scope="row">${row.id}</th><td>${row.title}</td><td><a href="${process.env.BASE_URL}/clips/${row.id}">Link</a></td><td>${row.finished ? "T" : "F"}</td><td>${row.visible ? "T" : "F"}</td></tr>`).join("")
                })
            })
            .catch(_ => res.status(401).json({ message: "Unauthorized use of this service" }))
    }
})

app.get("/operations", (req, res) => {
    if (!req.cookies.tk) res.redirect(`https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&response_type=code&redirect_uri=${process.env.DISCORD_REDIRECT_URL}&scope=identify`)
    else {
        jwtVerify(req.cookies.tk, new TextEncoder().encode(process.env.JWT_SECRET))
            .then(res => res.payload)
            .then(data => {
                if (data.elevated) res.json(operations)
                else throw new Error()
            })
            .catch(_ => res.status(401).json({ message: "Unauthorized use of this service" }))
    }
})

app.get("/logout", (req, res) => {
    if (!req.cookies.tk) res.redirect("/")
    else {
        res.clearCookie("tk")
        res.redirect("/")
    }
})

app.get("/auth", (req, res) => {
    if (!req.query.code) {
        res.status(403).json({})
        return
    }
    fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            "grant_type": "authorization_code",
            "client_id": process.env.DISCORD_CLIENT_ID as string,
            "client_secret": process.env.DISCORD_CLIENT_SECRET as string,
            "code": req.query.code as string,
            "redirect_uri": process.env.DISCORD_REDIRECT_URL as string
        })
    })
        .then(res => Promise.all([res.status, res.json()]))
        .then(data => {
            if (data[0] != 200) {
                res.status(403).json({})
                throw new Error()
            }
            return data[1].access_token
        })
        .then(accessToken => fetch("https://discord.com/api/users/@me", {
            headers: {
                "Authorization": `Bearer ${accessToken}`
            }
        }))
        .then(res => Promise.all([res.status, res.json()]))
        .then(async data => {
            if (data[0] != 200) {
                res.status(403).json({})
                throw new Error()
            }
            return data[1].id
        })
        .then(userId => db.query("SELECT * FROM users WHERE id = $1;", [userId]))
        .then(res => res.rows)
        .then(data => {
            if (data.length < 1) {
                res.status(401).json({})
                throw new Error()
            }
            return new SignJWT(data[0])
                .setProtectedHeader({ alg: "HS256" })
                .setIssuedAt()
                .setExpirationTime("7d")
                .sign(new TextEncoder().encode(process.env.JWT_SECRET))
        })
        .then(token => res.status(200).cookie("tk", token, { maxAge: 604800000, httpOnly: true }).json({ token: token }))
        .catch(_ => {
            if (!res.headersSent) res.status(503).json({})
        })
})

app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.cookies.tk) {
        res.status(401).json({ message: "Unauthorized use of this service" })
        return
    }
    let owner: string = ""
    let ownerName: string = ""
    let authorized = false
    let id: number = -1
    let thisUpload: Upload
    if (req.file === undefined) {
        res.status(403).json({ message: "Please upload a file" })
        return
    }
    let fileName = getFileName(req.file.originalname) || (req.file.filename + ".mp4")
    jwtVerify(req.cookies.tk, new TextEncoder().encode(process.env.JWT_SECRET))
        .then(async token => {
            authorized = true
            owner = token.payload.id as string
            ownerName = token.payload.username as string
            let video = ffmpeg(req.file?.path as string)
            thisUpload = {
                file: fileName,
                duration: NaN,
                progress: NaN,
                video: video
            }
            video.ffprobe((err, metadata) => {
                if (err) throw new Error(undefined)
                else {
                    if (metadata.format.duration && !isNaN(metadata.format.duration)) {
                        thisUpload.duration = metadata.format.duration
                    }
                }
            })
            if (process.env.CROP_ENABLED == "true") {
                const cropSourceWidth = process.env.CROP_SOURCE_WIDTH || "1920"
                const cropWidth = process.env.CROP_WIDTH || "1920"
                const cropHeight = process.env.CROP_HEIGHT || "1080"
                video = video.videoFilter(`crop=${cropWidth}:${cropHeight}:${(parseInt(cropSourceWidth) - parseInt(cropWidth)) / 2}:0`)
            }
            res.json({ file: req.file?.originalname })
            return db.query("INSERT INTO uploads(file, owner, title, description) VALUES($1, $2, $3, $4) RETURNING *;", [fileName, owner, req.file?.originalname.replace("unknown_replay", "Replay"), ""])
        })
        .then(data => data.rows)
        .then(async data => {
            if (data.length < 1) {
                await db.query("INSERT INTO alerts(owner, type, upload_name) VALUES($1, 'error', $2);", [owner, req.file?.originalname])
                throw new Error(undefined)
            } else {
                id = data[0].id
                uploads[id] = thisUpload
                return Promise.all([videoSave(uploads[id].video, uploads[id]), db.query("INSERT INTO alerts(owner, type, upload) VALUES($1, 'processing', $2);", [owner, id])])
            }
        })
        .then(data => data[1])
        .then(async _ => {
            if (id == -1) {
                await db.query("UPDATE alerts SET type = 'error' WHERE upload = $2", [id])
                throw new Error(undefined)
            }
            return db.query("UPDATE uploads SET finished = true WHERE id = $1 RETURNING *;", [id])
        })
        .then(data => data.rows)
        .then(async data => {
            if (data.length < 1) {
                await db.query("UPDATE alerts SET type = 'error' WHERE upload = $1", [id])
                throw new Error(undefined)
            }
            else return db.query("UPDATE alerts SET type = 'finished' WHERE upload = $1;", [id])
        })
        .then(_ => videoThumbnail(ffmpeg(`processed/${fileName}`), `${id}.png`))
        .then(_ => fetch(process.env.DISCORD_WEBHOOK as string, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ content: `A clip (**${req.file?.originalname.replace("unknown_replay", "Replay")}**) was uploaded by ${ownerName} at ${process.env.BASE_URL}/clips/${id}` })
        }))
        .catch(async e => {
            if (!authorized) res.status(401).json({ message: "Unauthorized use of this service" })
            if (e != undefined) await db.query("INSERT INTO alerts(owner, type, message, upload_name) VALUES($1, 'error', $2, $3)", [owner, "There was an issue processing this file", req.file?.originalname])
            if (!res.headersSent) res.status(403).json({ message: "There was an error uploading your file" })
            console.log(e.msg || e.message)
        })
})

app.post("/clips/:clip/edit", (req, res) => {
    if (!req.cookies.tk) {
        res.status(401).json({ message: "Unauthorized use of this service" })
        return
    }
    let owner: string = ""
    let ownerName: string = ""
    let fileName: string = ""
    let title: string = ""
    let authorized = false
    let id: number = -1
    let thisUpload: Upload
    jwtVerify(req.cookies.tk, new TextEncoder().encode(process.env.JWT_SECRET))
        .then(data => data.payload)
        .then(payload => {
            authorized = true
            owner = payload.id as string
            ownerName = payload.username as string
            return db.query("SELECT * FROM uploads WHERE id = $1 AND owner = $2", [req.params.clip, payload.id])
        })
        .then(data => data.rows)
        .then(uploads => {
            if (uploads.length > 0 && uploads[0].finished) return uploads[0]
            else throw new Error(undefined)
        })
        .then(async upload => {
            let video = ffmpeg("processed/" + upload.file)
            if (req.body.seek) video = video.seek(req.body.seek)
            if (req.body.to) video = video.inputOption(`-to ${req.body.to}`)
            fileName = randomUUID().replaceAll("-", "")
            title = upload.title
            thisUpload = {
                file: fileName + ".mp4",
                duration: NaN,
                progress: NaN,
                video: video
            }
            video.ffprobe((err, metadata) => {
                if (err) throw new Error(err)
                else {
                    if (metadata.format.duration && !isNaN(metadata.format.duration)) {
                        thisUpload.duration = metadata.format.duration
                    }
                }
            })
            res.json({ file: upload.title })
            return db.query("INSERT INTO uploads(file, owner, title, description, edited) VALUES($1, $2, $3, $4, $5) RETURNING *;", [fileName + ".mp4", upload.owner, upload.title, upload.description, upload.id])
        })
        .then(data => data.rows)
        .then(async data => {
            if (data.length < 1) {
                await db.query("INSERT INTO alerts(owner, type, upload_name) VALUES($1, 'error', $2);", [owner, fileName])
                throw new Error(undefined)
            } else {
                id = data[0].id
                uploads[id] = thisUpload
                return Promise.all([videoSave(uploads[id].video, uploads[id]), db.query("INSERT INTO alerts(owner, type, upload) VALUES($1, 'processing', $2);", [owner, id])])
            }
        })
        .then(data => data[1])
        .then(async _ => {
            if (id == -1) {
                await db.query("UPDATE alerts SET type = 'error' WHERE upload = $2", [id])
                throw new Error(undefined)
            }
            return db.query("UPDATE uploads SET finished = true WHERE id = $1 RETURNING *;", [id])
        })
        .then(data => data.rows)
        .then(async data => {
            if (data.length < 1) {
                await db.query("UPDATE alerts SET type = 'error' WHERE upload = $1", [id])
                throw new Error(undefined)
            }
            else return db.query("UPDATE alerts SET type = 'finished' WHERE upload = $1;", [id])
        })
        .then(_ => videoThumbnail(ffmpeg(`processed/${fileName}.mp4`), `${id}.png`))
        .then(_ => fetch(process.env.DISCORD_WEBHOOK as string, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ content: `An edited clip (**${title}**) was uploaded by ${ownerName} at ${process.env.BASE_URL}/clips/${id}` })
        }))
        .catch(async e => {
            if (!authorized) res.status(401).json({ message: "Unauthorized use of this service" })
            if (e != undefined) await db.query("INSERT INTO alerts(owner, type, message, upload_name) VALUES($1, 'error', $2, $3)", [owner, "There was an issue processing this file", fileName])
            if (!res.headersSent) res.status(403).json({ message: "There was an error editing your file" })
            console.log(e.msg || e.message)
        })
})

app.listen(process.env.PORT, () => console.log("Server Started"))
