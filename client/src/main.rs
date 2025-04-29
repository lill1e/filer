use clap::Parser;
use cookie::Cookie;
use serde_derive::Deserialize;
use ureq_multipart::MultipartRequest;

static BASE_URL: &'static str = "https://clips.lillie.rs";

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

    /// The config you would like to upload using
    #[arg(short, long)]
    config: Option<usize>,
}

fn upload(path: String, token: String, config: Option<&str>) -> () {
    let mut queries: Vec<(&str, &str)> = Vec::new();
    if let Some(config_id) = config {
        queries.push(("config", config_id));
    }
    match ureq::post(&format!("{}/upload", BASE_URL))
        .set(
            "Cookie",
            &Cookie::build(("tk", token))
                .domain(BASE_URL)
                .build()
                .to_string(),
        )
        .query_pairs(queries)
        .send_multipart_file("file", path)
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

fn main() {
    let args = Args::parse();
    let c_id = match args.config {
        Some(config_id) => config_id.to_string(),
        None => String::from(""),
    };
    let config_id: Option<&str>;
    if c_id.is_empty() {
        config_id = None;
    } else {
        config_id = Some(&c_id);
    }
    upload(args.path, args.token, config_id);
}
