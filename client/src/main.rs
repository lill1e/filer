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
    if let None = env::args().skip(1).next() {
        println!("Please provide a file to upload");
        return;
    }
    match ureq::post("https://clips.lillie.rs/upload")
        .send_multipart_file("file", env::args().skip(1).next().unwrap())
    {
        Ok(res) => match res.status() {
            200 => match res.into_json::<UploadResult>() {
                Ok(value) => println!("Placeholder message: {:?}", value),
                Err(error) => println!("An error occured with the upload request: {}", error),
            },
            _ => match res.into_json::<UploadError>() {
                Ok(value) => println!(
                    "An error occured with the upload request: {}",
                    value.message
                ),
                Err(error) => println!("An error occured with the upload request: {}", error),
            },
        },
        Err(error) => println!("An error occured with the upload request: {}", error),
    };
}
