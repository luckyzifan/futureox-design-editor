# Patched Rust dependencies

`rust-s3` 0.37.2 and `aws-creds` 0.39.1 are mirrored from crates.io because
their current releases still pin the vulnerable `quick-xml` 0.38 series.
The only local change is upgrading `quick-xml` to 0.41. This patch can be
removed once upstream publishes compatible releases using 0.41 or newer.
