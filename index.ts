import express from "express"
import multer from "multer"
import ffmpeg from "ffmpeg"
import * as dotenv from "dotenv"
import { Client } from "pg"

const app = express()
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

app.post("/upload", upload.single("file"), (req, res) => {
    let requestFufilled = false
    let alertRecorded = false
    let id: number = -1
    if (req.file === undefined) {
        res.status(403).json({ message: "Please upload a file" })
        return
    }
    let fileName = getFileName(req.file.originalname) || (req.file.filename + ".mp4")
    new ffmpeg(req.file.path)
        .then(async video => {
            if (process.env.CROP_ENABLED == "true") {
                const cropSourceWidth = process.env.CROP_SOURCE_WIDTH || "1920"
                const cropWidth = process.env.CROP_WIDTH || "1920"
                const cropHeight = process.env.CROP_HEIGHT || "1080"
                video.addCommand("-vf", `crop=${cropWidth}:${cropHeight}:${(parseInt(cropSourceWidth) - parseInt(cropWidth)) / 2}:0`)
            }
            res.json({ file: req.file?.originalname })
            requestFufilled = true
            return Promise.all([db.query("INSERT INTO uploads(file, owner, title, description) VALUES($1, $2, $3, $4) RETURNING *;", [fileName, "1234", req.file?.originalname, ""]), video])
        })
        .then(data => [data[0].rows, data[1]])
        .then(async data => {
            if ((data[0] as any).length < 1) {
                await db.query("INSERT INTO alerts(owner, type, upload_name) VALUES($1, 'error', $2);", ["1234", req.file?.originalname])
                alertRecorded = true
                throw new Error(undefined)
            } else {
                id = (data[0] as any[])[0].id
                await db.query("INSERT INTO alerts(owner, type, upload) VALUES($1, 'processing', $2);", ["1234", id])
                alertRecorded = true
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
            if (data.length < 1) await db.query("UPDATE alerts SET type = 'error' WHERE upload = $1", [id])
            else await db.query("UPDATE alerts SET type = 'finished' WHERE upload = $1;", [id])
        })
        .catch(async e => {
            if (id != -1 && e != undefined && alertRecorded) await db.query("UPDATE alerts SET type = 'error' AND message = $1 WHERE upload = $2", [e.message || e.msg, id])
            else if (e != undefined && !alertRecorded) await db.query("INSERT INTO alerts(owner, type, message, upload_name) VALUES($1, 'error', $2, $3)", ["1234", e.message || e.msg, req.file?.originalname])
            if (!requestFufilled) res.status(403).json({ message: "There was an error uploading your file", error: e.msg || e.message })
        })
})

app.listen(3000, () => console.log("Server Started"))
