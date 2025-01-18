use cookie::Cookie;
use serde_derive::Deserialize;
use std::env;
use ureq_multipart::MultipartRequest;

#[derive(Debug, Deserialize)]
struct UploadResult {
    file: String,
}

#[derive(Debug, Deserialize)]
struct UploadError {
    message: String,
}

fn main() {
    if let None = env::args().skip(2).next() {
        println!("Please provide a file to upload");
        return;
    }
    let mut args = env::args().skip(1);
    match ureq::post("https://clips.lillie.rs/upload")
        .set(
            "Cookie",
            &Cookie::build(("tk", args.next().unwrap()))
                .domain("https://clips.lillie.rs")
                .build()
                .to_string(),
        )
        .send_multipart_file("file", args.next().unwrap())
    {
        Ok(res) => match res.status() {
            200 => match res.into_json::<UploadResult>() {
                Ok(result) => println!("{} is currently processing", result.file),
                Err(error) => println!("An error occured with the upload request: {}", error),
            },
            _ => match res.into_json::<UploadError>() {
                Ok(result) => println!(
                    "An error occured with the upload request: {}",
                    result.message
                ),
                Err(error) => println!("An error occured with the upload request: {}", error),
            },
        },
        Err(error) => println!("An error occured with the upload request: {}", error),
    };
}
