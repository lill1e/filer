import express from "express"
import multer from "multer"
import ffmpeg from "ffmpeg"
import * as dotenv from "dotenv"
import { Client } from "pg"
import { URLSearchParams } from "url"
import { jwtVerify, SignJWT } from "jose"
import cookieParser from "cookie-parser"

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
    db.query("SELECT uploads.*,users.username FROM uploads uploads JOIN users users ON uploads.owner = users.id WHERE uploads.id = $1", [req.params.clip]).then(data => data.rows).then(data => {
        if (data[0].finished) res.render(`${process.cwd()}/views/clip.ejs`, {
            clipData: data[0]
        })
        else res.status(403).json({})
    }).catch(_ => res.status(403).json({}))
})

app.get("/", (req, res) => {
    if (!req.cookies.tk) res.redirect(`https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&response_type=code&redirect_uri=${process.env.DISCORD_REDIRECT_URL}&scope=identify`)
    else {
        jwtVerify(req.cookies.tk, new TextEncoder().encode(process.env.JWT_SECRET))
            .then(res => res.payload)
            .then(res.json)
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
    if (req.file === undefined) {
        res.status(403).json({ message: "Please upload a file" })
        return
    }
    let fileName = getFileName(req.file.originalname) || (req.file.filename + ".mp4")
    jwtVerify(req.cookies.tk, new TextEncoder().encode(process.env.JWT_SECRET))
        .then(res => {
            authorized = true
            owner = res.payload.id as string
            ownerName = res.payload.username as string
            return new ffmpeg(req.file?.path as string)
        })
        .then(async video => {
            if (process.env.CROP_ENABLED == "true") {
                const cropSourceWidth = process.env.CROP_SOURCE_WIDTH || "1920"
                const cropWidth = process.env.CROP_WIDTH || "1920"
                const cropHeight = process.env.CROP_HEIGHT || "1080"
                video.addCommand("-vf", `crop=${cropWidth}:${cropHeight}:${(parseInt(cropSourceWidth) - parseInt(cropWidth)) / 2}:0`)
            }
            res.json({ file: req.file?.originalname })
            return Promise.all([db.query("INSERT INTO uploads(file, owner, title, description) VALUES($1, $2, $3, $4) RETURNING *;", [fileName, owner, req.file?.originalname, ""]), video])
        })
        .then(data => [data[0].rows, data[1]])
        .then(async data => {
            if ((data[0] as any).length < 1) {
                await db.query("INSERT INTO alerts(owner, type, upload_name) VALUES($1, 'error', $2);", [owner, req.file?.originalname])
                throw new Error(undefined)
            } else {
                id = (data[0] as any[])[0].id
                await db.query("INSERT INTO alerts(owner, type, upload) VALUES($1, 'processing', $2);", [owner, id])
                return (data[1] as any).save("processed/" + fileName)
            }
        })
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
        .then(_ => new ffmpeg(`processed/${fileName}`))
        .then(video => {
            video.setVideoFormat("mjpeg")
            video.addCommand("-frames", "1")
            return video.save(`thumbnails/${id}.png`)
        })
        .then(_ => fetch(process.env.DISCORD_WEBHOOK as string, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ content: `A clips was uploaded by ${ownerName} at ${process.env.BASE_URL}/clips/${id}` })
        }))
        .catch(async e => {
            if (!authorized) res.status(401).json({ message: "Unauthorized use of this service" })
            if (e != undefined) await db.query("INSERT INTO alerts(owner, type, message, upload_name) VALUES($1, 'error', $2, $3)", [owner, "There was an issue processing this file", req.file?.originalname])
            if (!res.headersSent) res.status(403).json({ message: "There was an error uploading your file" })
            console.log(e.msg || e.message)
        })
})

app.listen(process.env.PORT, () => console.log("Server Started"))
