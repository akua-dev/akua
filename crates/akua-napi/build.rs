// napi-rs's build helper sets the right linker flags per platform
// (`-undefined dynamic_lookup` on macOS, `/FORCE:UNRESOLVED` on
// Windows) so node's symbols get resolved at addon load time. Also
// emits the per-target build markers that `@napi-rs/cli` reads
// when it stages binaries into platform-suffixed npm packages.

extern crate napi_build;

fn main() {
    println!("cargo:rerun-if-env-changed=RUSTC_LINKER");
    let direct_darwin_linker = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var_os("RUSTC_LINKER").is_some_and(|linker| {
            std::path::Path::new(&linker).file_name() == Some(std::ffi::OsStr::new("rust-lld"))
        });
    if direct_darwin_linker {
        // The direct linker accepts native flags; the helper's -Wl token is
        // intended for a compiler driver. Preserve its build metadata watches.
        for variable in [
            "DEBUG_GENERATED_CODE",
            "TYPE_DEF_TMP_PATH",
            "CARGO_CFG_NAPI_RS_CLI_VERSION",
            "NAPI_DEBUG_GENERATED_CODE",
            "NAPI_TYPE_DEF_TMP_FOLDER",
            "NAPI_FORCE_BUILD_AKUA_NAPI",
        ] {
            println!("cargo:rerun-if-env-changed={variable}");
        }
        println!("cargo:rustc-cdylib-link-arg=-undefined");
        println!("cargo:rustc-cdylib-link-arg=dynamic_lookup");
    } else {
        napi_build::setup();
    }
}
