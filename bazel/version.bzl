"""The package toolchain version, from Cargo.toml's workspace.package.version."""

load("@source_version//:version.bzl", _PACKAGE_SOURCE_VERSION = "PACKAGE_SOURCE_VERSION")

PACKAGE_SOURCE_VERSION = _PACKAGE_SOURCE_VERSION
