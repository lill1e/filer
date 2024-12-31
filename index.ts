import express from "express"
import multer from "multer"
import ffmpeg from "ffmpeg"
import * as dotenv from "dotenv"

const app = express()
dotenv.config()
const upload = multer({
    dest: "uploads/"
})

app.use(express.json())

function getFileName(fileName: string): string | null {
    const match = fileName.substring(0, fileName.length - 1).match(new RegExp("([0-9])+", "g"))
    if (!match || match.length != 7) {
        return null
    } else {
        return match.slice(0, 3).join(".") + "-" + match.slice(3).join(".") + ".mp4"
    }
}

app.post("/test", upload.single("file"), (req, res) => {
    if (req.file === undefined) {
        res.status(403).json({ message: "Please upload a file" })
        return
    }
    let fileName = getFileName(req.file.originalname) || (req.file.filename + ".mp4")
    new ffmpeg(req.file.path)
        .then(video => {
            video.addCommand("-vf", "crop=2134:1200:853:0")
            video.save(__dirname + "/processed/" + fileName)
        })
        .then(_ => res.json({ file: req.file?.originalname }))
        .catch(e => res.status(403).json({ message: "There was an error uploading your file", error: e.msg }))
})

app.listen(3000, () => console.log("Server Started"))
