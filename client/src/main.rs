use clap::Parser;
use cookie::Cookie;
use serde_derive::Deserialize;
use ureq_multipart::MultipartRequest;

#[derive(Debug, Deserialize)]
struct UploadResult {
    file: String,
}

#[derive(Debug, Deserialize)]
struct UploadError {
    message: String,
}

#[derive(Parser)]
struct Args {
    /// The path to the file you would like to upload
    #[arg(short, long)]
    path: String,

    /// The provided token to use this service
    #[arg(short, long)]
    token: String,
}

fn main() {
    let args = Args::parse();
    match ureq::post("https://clips.lillie.rs/upload")
        .set(
            "Cookie",
            &Cookie::build(("tk", args.token))
                .domain("https://clips.lillie.rs")
                .build()
                .to_string(),
        )
        .send_multipart_file("file", args.path)
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
