import express from "express"
import multer from "multer"
import ffmpeg, { FfmpegCommand, FfprobeData } from "fluent-ffmpeg"
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

interface Operation {
    file: string,
    duration: number,
    progress: number,
    video: number
}
interface Operations {
    [key: number]: Operation
}
interface Upload {
    file: string,
    displayName: string,
    duration: number,
    progress: number,
    width: number,
    height: number,
    video: FfmpegCommand,
    tag?: string
}
interface Uploads {
    [key: number]: Upload
}
interface Config {
    id: number,
    display_name?: string,
    owner?: string,
    crop_width?: number,
    crop_height?: number,
    crop_source_width?: number
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

function ffprobe(video: FfmpegCommand): Promise<FfprobeData> {
    return new Promise((resolve, reject) => {
        video.ffprobe((err, metadata) => {
            if (err) reject(err)
            else resolve(metadata)
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

app.post("/clips/:clip/visibility", (req, res) => {
    if (!req.cookies.tk) res.status(401).json({ message: "Unauthorized use of this service" })
    else jwtVerify(req.cookies.tk, new TextEncoder().encode(process.env.JWT_SECRET))
        .then(res => res.payload)
        .then(payload => db.query("UPDATE uploads SET visible = NOT visible WHERE id = $1 AND owner = $2 RETURNING *;", [req.params.clip, payload.id]))
        .then(data => data.rowCount)
        .then(rows => {
            if (rows && rows > 0) res.json({})
            else res.status(401).json({ message: "Unauthorized use of this service" })
        })
        .catch(_ => {
            if (!res.headersSent) res.status(503).json({})
        })
})

app.get("/", (req, res) => {
    if (!req.cookies.tk) res.redirect(`https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&response_type=code&redirect_uri=${process.env.DISCORD_REDIRECT_URL}&scope=identify`)
    else {
        let filterQuery = ""
        let sort = "ASC"
        if (req.query.filter) {
            if (req.query.filter == "processing") filterQuery = " AND finished = false"
            if (req.query.filter == "processed") filterQuery = " AND finished = true"
            if (req.query.filter == "public") filterQuery = " AND visible = true"
            if (req.query.filter == "private") filterQuery = " AND finished = false"
        }
        if (req.query.sort) {
            if (req.query.sort == "descending") sort = "DESC"
        }
        jwtVerify(req.cookies.tk, new TextEncoder().encode(process.env.JWT_SECRET))
            .then(res => res.payload)
            .then(data => db.query(`SELECT id,title,finished,visible,tag FROM uploads WHERE owner = $1${filterQuery} ORDER BY id ${sort};`, [data.id]))
            .then(data => data.rows)
            .then(data => {
                if (data.length > 0) data[data.length - 1].last = true
                res.render(`${process.cwd()}/views/list.ejs`, {
                    uploads: data.map(row => `<tr><th${row.last ? " style=\"border-bottom-left-radius: .75rem;\"" : ""} scope="row">${row.id}</th><td>${row.visible ? "" : "🔒 "}${row.title}</td><td><a href="${process.env.BASE_URL}/clips/${row.id}">Link</a></td><td>${row.tag ?? "None"}</td><td${row.last ? " style=\"border-bottom-right-radius: .75rem;\"" : ""}>${row.finished ? "✅" : "❌"}</td></tr>`).join("")
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
                if (data.elevated) {
                    let operations: Operations = {}
                    Object.keys(uploads).map(Number).forEach(upload => {
                        operations[upload] = { ...uploads[upload], video: upload }
                    })
                    res.json(operations)
                }
                else throw new Error()
            })
            .catch(_ => res.status(401).json({ message: "Unauthorized use of this service" }))
    }
})

app.get("/operations/:operation", (req, res) => {
    if (!req.cookies.tk) res.redirect(`https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&response_type=code&redirect_uri=${process.env.DISCORD_REDIRECT_URL}&scope=identify`)
    else {
        jwtVerify(req.cookies.tk, new TextEncoder().encode(process.env.JWT_SECRET))
            .then(res => res.payload)
            .then(data => {
                if (data.elevated) {
                    let operations: Operations = {}
                    Object.keys(uploads).map(Number).forEach(upload => {
                        operations[upload] = { ...uploads[upload], video: upload }
                    })
                    if (req.params.operation && operations[parseInt(req.params.operation)]) res.json(operations[parseInt(req.params.operation)])
                    else res.status(404).json({ message: "Operation not found" })
                }
                else throw new Error()
            })
            .catch(_ => res.status(401).json({ message: "Unauthorized use of this service" }))
    }
})

app.get("/processing", (req, res) => {
    if (!req.cookies.tk) res.redirect(`https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&response_type=code&redirect_uri=${process.env.DISCORD_REDIRECT_URL}&scope=identify`)
    else {
        jwtVerify(req.cookies.tk, new TextEncoder().encode(process.env.JWT_SECRET))
            .then(res => res.payload)
            .then(user => {
                if (!user.elevated) throw new Error()
                let uploadIds: number[] = Object.keys(uploads).map(s => Number(s))
                let last = -1
                if (uploadIds.length > 0) last = uploadIds[uploadIds.length - 1]
                res.render(`${process.cwd()}/views/operations.ejs`, {
                    operations: uploadIds.map(upload => `<tr><th${last == upload ? " style=\"border-bottom-left-radius: .75rem;\"" : ""} scope="row">${upload}</th><td>${uploads[upload].displayName}</td><td><a href="${process.env.BASE_URL}/clips/${uploads[upload].video}">Link</a></td><td>${uploads[upload].width}x${uploads[upload].height}</td><td>${uploads[upload].tag}</td><td${last == upload ? " style=\"border-bottom-right-radius: .75rem;\"" : ""}>${uploads[upload].progress.toFixed(2)}%</td></tr>`).join("")
                })
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

app.get("/refresh", (req, res) => {
    if (!req.cookies.tk) res.status(401).json({ message: "Unauthorized use of this service" })
    else {
        jwtVerify(req.cookies.tk, new TextEncoder().encode(process.env.JWT_SECRET))
            .then(token => token.payload.id as string)
            .then(userId => db.query("SELECT * FROM users WHERE id = $1;", [userId]))
            .then(res => res.rows)
            .then(data => {
                if (data.length < 1) {
                    res.status(401).json({ message: "Unauthorized use of this service" })
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
                res.status(401).json({ message: "Unauthorized use of this service" })
            })
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
        .then(token => res.status(200).cookie("tk", token, { maxAge: 604800000, httpOnly: true }).redirect("/"))
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
    if (!req.file) {
        res.status(403).json({ message: "Please upload a file" })
        return
    }
    let fileName = getFileName(req.file.originalname) || (req.file.filename + ".mp4")
    jwtVerify(req.cookies.tk, new TextEncoder().encode(process.env.JWT_SECRET))
        .then(async token => {
            authorized = true
            owner = token.payload.id as string
            ownerName = token.payload.username as string
            thisUpload = {
                file: fileName,
                displayName: req.file?.originalname.replace("unknown_replay", "Replay") as string,
                duration: NaN,
                progress: NaN,
                width: NaN,
                height: NaN,
                video: ffmpeg(req.file?.path as string)
            }
            return Promise.all([ffprobe(thisUpload.video), (req.query.config ? db.query("SELECT * FROM configs WHERE id = $1;", [req.query.config]) : null)])
        })
        .then(([videoData, configData]) => {
            if (configData) {
                if (configData.rowCount && configData.rowCount > 0) return Promise.all([videoData, configData.rows[0] as Config])
                else {
                    res.status(403).json({ message: "Please provide a valid config" })
                    throw new Error(undefined)
                }
            } else return Promise.all([videoData, { id: -1 } as Config])
        })
        .then(([videoData, configData]) => {
            if (configData.display_name) thisUpload.tag = configData.display_name
            let video = thisUpload.video
            let videos = videoData.streams.filter(s => s.codec_type == "video")
            if (videos.length <= 0 || !videos[0].width || !videos[0].height) throw new Error(undefined)
            if (videoData.format.duration && !isNaN(videoData.format.duration)) {
                thisUpload.duration = videoData.format.duration
                thisUpload.width = videos[0].width
                thisUpload.height = videos[0].height
            }
            if (configData.crop_width && configData.crop_height && configData.crop_source_width) {
                video = video.videoFilter(`crop=${configData.crop_width}:${configData.crop_height}:${(configData.crop_source_width - configData.crop_width) / 2}:0`)
            }
            res.json({ file: req.file?.originalname })
            return db.query("INSERT INTO uploads(file, owner, title, description, width, height, tag) VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING *;", [fileName, owner, thisUpload.displayName, "", thisUpload.width, thisUpload.height, thisUpload.tag])
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
            body: JSON.stringify({ content: `A clip (**${thisUpload.displayName}**) was uploaded by ${ownerName} at ${process.env.BASE_URL}/clips/${id}` })
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
            if (req.body.seek) thisUpload.video = thisUpload.video.seek(req.body.seek)
            if (req.body.to) thisUpload.video = thisUpload.video.inputOption(`-to ${req.body.to}`)
            fileName = randomUUID().replaceAll("-", "")
            title = upload.title
            thisUpload = {
                file: fileName + ".mp4",
                displayName: upload.title,
                duration: NaN,
                progress: NaN,
                width: upload.width,
                height: upload.height,
                video: ffmpeg("processed/" + upload.file),
                tag: upload.tag
            }
            thisUpload.video.ffprobe((err, metadata) => {
                if (err) throw new Error(err)
                else {
                    if (metadata.format.duration && !isNaN(metadata.format.duration)) {
                        thisUpload.duration = metadata.format.duration
                    }
                }
            })
            res.json({ file: upload.title })
            return db.query("INSERT INTO uploads(file, owner, title, description, edited, width, height, tag) VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;", [fileName + ".mp4", upload.owner, upload.title, upload.description, upload.id, upload.width, upload.height, upload.tag])
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
