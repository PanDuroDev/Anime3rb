use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign::{PublicKey, SecretKeyBox};
use std::{env, error::Error, fs, path::Path, process};

fn main() {
    if let Err(error) = run() {
        eprintln!("Updater signing-key inspection failed: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let private_key_input = env::var("TAURI_SIGNING_PRIVATE_KEY")?;
    let private_key_content = if Path::new(&private_key_input).is_file() {
        fs::read_to_string(&private_key_input)?
    } else {
        private_key_input
    };

    // Tauri stores the Minisign key file as a base64-encoded UTF-8 document.
    let private_key_document = String::from_utf8(STANDARD.decode(private_key_content.trim())?)?;
    let secret_key_box = SecretKeyBox::from_string(&private_key_document)?;
    let password = env::var("TAURI_SIGNING_PRIVATE_KEY_PASSWORD").unwrap_or_default();
    let secret_key = secret_key_box.into_secret_key(Some(password))?;

    // Derive and print only the public half. The private key is never written or logged.
    let public_key = PublicKey::from_secret_key(&secret_key)?;
    let public_key_id = public_key
        .keynum()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let public_key_document = public_key.to_box()?.to_string();
    let encoded_public_key = STANDARD.encode(&public_key_document);

    let config_text = fs::read_to_string("src-tauri/tauri.conf.json")?;
    let config: serde_json::Value = serde_json::from_str(&config_text)?;
    let embedded_encoded = config
        .get("plugins")
        .and_then(|v| v.get("updater"))
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .ok_or("plugins.updater.pubkey is missing from tauri.conf.json")?;
    let embedded_document = STANDARD.decode(embedded_encoded.trim())?;

    println!("Derived updater public key ID: {public_key_id}");
    if embedded_document != public_key_document.as_bytes() {
        let derived = public_key_document.as_bytes();
        let mismatch = embedded_document
            .iter()
            .zip(derived.iter())
            .position(|(expected, actual)| expected != actual)
            .unwrap_or_else(|| embedded_document.len().min(derived.len()));

        println!("Derived updater public key (public material only):");
        println!("{encoded_public_key}");
        eprintln!(
            "TAURI_SIGNING_PRIVATE_KEY does not match src-tauri/tauri.conf.json.              The public key documents differ at byte {mismatch} (embedded length {}, derived length {}).              A matching key ID alone is not sufficient.",
            embedded_document.len(),
            derived.len()
        );
        process::exit(2);
    }

    println!("Updater private key matches the public key embedded in tauri.conf.json.");
    Ok(())
}
