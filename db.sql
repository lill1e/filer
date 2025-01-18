CREATE TABLE users (
    id PRIMARY VARCHAR(20) NOT NULL,
    username VARCHAR(32) NOT NULL
);

CREATE TABLE uploads (
    id PRIMARY VARCHAR(20) NOT NULL,
    file TEXT NOT NULL,
    owner VARCHAR(20) NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    finished BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE alerts (
    owner VARCHAR(20) NOT NULL,
    type VARCHAR(20) NOT NULL,
    message TEXT,
    upload INTEGER,
    upload_name TEXT
);
