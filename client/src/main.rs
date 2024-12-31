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
    let path = "example.mp4";
    println!("Hello, world!");
    match ureq::post("https://clips.lillie.rs/upload").send_multipart_file("file", path) {
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
