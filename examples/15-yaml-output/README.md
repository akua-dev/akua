# 15-yaml-output

The exact YAML `akuapkg render` writes: keys in the order the Package wrote
them, block sequences flush with their key, multi-line strings as block
literals, and a string single-quoted whenever some YAML parser could read it
as something else (a leading digit, `-`, `.` or `+`, or a YAML 1.1 word such
as `yes`, `on` or `null`).

```sh
akuapkg render --out ./out
diff -r out rendered
```

`rendered/` is the committed output; a render must reproduce it byte for
byte.
