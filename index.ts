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

app.post("/test", upload.single("file"), (req, res) => {
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
            let id: number = -1;
            db.query("INSERT INTO uploads(file, owner, title, description) VALUES($1, $2, $3, $4) RETURNING *;", [fileName, "1234", req.file?.originalname, ""])
                .then(data => data.rows)
                .then(async data => {
                    if (data.length < 1) {
                        await db.query("INSERT INTO alerts(owner, type, upload_name) VALUES($1, 'error', $2);", ["1234", req.file?.originalname])
                    } else id = data[0].id
                })
                .catch(async e => await db.query("INSERT INTO alerts(owner, type, upload_name, message) VALUES($1, 'error', $2, $3);", ["1234", req.file?.originalname, e.message]))
            if (id != -1) await db.query("INSERT INTO alerts(owner, type, upload) VALUES($1, 'processing', $2);", ["1234", id])
            return Promise.all([video.save("processed/" + fileName), id])
        })
        .then(data => {
            if (data[1] != -1) {
                db.query("UPDATE uploads SET finished = true WHERE id = $1 RETURNING *;", [data[1]])
                    .then(data => data.rows)
                    .then(async data => {
                        if (data.length < 1) {
                            await db.query("UPDATE alerts SET type = 'error' WHERE upload = $1", [data[1]])
                        } else {
                            await db.query("UPDATE alerts SET type = $1 WHERE upload = $2;", ["finished", req.file?.originalname])
                        }
                    })
                    .catch(async e => await db.query("UPDATE alerts SET type = 'error' AND message = $1 WHERE upload = $2", [e.message, data[1]]))
            }
        })
        .catch(e => res.status(403).json({ message: "There was an error uploading your file", error: e.msg }))
})

app.listen(3000, () => console.log("Server Started"))
