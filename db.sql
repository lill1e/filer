CREATE TABLE users (
    id VARCHAR(20) PRIMARY KEY NOT NULL,
    username VARCHAR(32) NOT NULL,
    elevated boolean NOT NULL DEFAULT false,
    pfp TEXT NOT NULL
);

CREATE TABLE uploads (
    id SERIAL PRIMARY KEY NOT NULL,
    file TEXT NOT NULL,
    owner VARCHAR(20) NOT NULL references users(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    finished BOOLEAN NOT NULL DEFAULT false,
    visible BOOLEAN NOT NULL DEFAULT false,
    edited integer NOT NULL DEFAULT -1,
    width integer NOT NULL,
    height integer NOT NULL,
    duration integer NOT NULL,
    tag TEXT
);

CREATE TABLE alerts (
    owner VARCHAR(20) NOT NULL,
    type VARCHAR(20) NOT NULL,
    message TEXT,
    upload INTEGER references uploads(id),
    upload_name TEXT
);

CREATE TABLE configs (
    id SERIAL PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    owner VARCHAR(20) NOT NULL references users(id),
    crop_width INTEGER,
    crop_height INTEGER,
    crop_source_height INTEGER
);
