//! Linker for aarch64 Linux package artifacts: zig's `c++` driver minus the
//! Cortex-A53 erratum 843419 flag.
//!
//! Rust 1.98 adds `-Wl,--fix-cortex-a53-843419` to every
//! aarch64-unknown-linux-gnu link, and zig (every release through 0.16)
//! rejects it as an unsupported linker argument. cargo-zigbuild 0.23 drops it
//! the same way; links made with Rust 1.97 and earlier never carried it.
//!
//! `PACKAGE_ZIG_LINKER` names zig's driver for the target, relative to the
//! execroot that rustc runs the linker in.

use std::env;
use std::fs;
use std::process::{Command, exit};

const ERRATUM_FLAG: &str = "-Wl,--fix-cortex-a53-843419";

fn main() {
    let linker = env::var_os("PACKAGE_ZIG_LINKER").expect("PACKAGE_ZIG_LINKER names zig's linker driver");
    let args = env::args().skip(1).filter(|arg| arg != ERRATUM_FLAG).map(|arg| {
        // rustc moves its arguments into a response file when the command
        // line is too long; the flag is then one of its lines.
        let Some(path) = arg.strip_prefix('@') else { return arg };
        let contents = fs::read_to_string(path).expect("read the linker response file");
        let filtered = format!("{path}.zig");
        let lines: Vec<&str> = contents.lines().filter(|line| *line != ERRATUM_FLAG).collect();
        fs::write(&filtered, lines.join("\n")).expect("write the filtered response file");
        format!("@{filtered}")
    });
    let status = Command::new(linker).args(args).status().expect("run zig's linker driver");
    exit(status.code().unwrap_or(1));
}
