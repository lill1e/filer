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
    const match = fileName.match(new RegExp("([0-9])+|.mp4", "g"))
    if (!match || match.length != 8) {
        return null
    } else {
        return match.slice(0, 3).join(".") + "-" + match.slice(3, 6).join(".") + match[6]
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
            if (process.env.cropEnabled == "true") {
                const cropSourceWidth = process.env.cropSourceWidth || "1920"
                const cropWidth = process.env.cropWidth || "1920"
                const cropHeight = process.env.cropHeight || "1080"
                video.addCommand("-vf", `crop=${cropWidth}:${cropHeight}:${(parseInt(cropSourceWidth) - parseInt(cropWidth)) / 2}:0`)
            }
            video.save("processed/" + fileName)
        })
        .then(_ => res.json({ file: req.file?.originalname }))
        .catch(e => res.status(403).json({ message: "There was an error uploading your file", error: e.msg }))
})

app.listen(3000, () => console.log("Server Started"))
