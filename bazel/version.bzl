"""Public build consumers use the single release version input."""

load("//:version.bzl", "AKUA_VERSION")

PACKAGE_SOURCE_VERSION = AKUA_VERSION
