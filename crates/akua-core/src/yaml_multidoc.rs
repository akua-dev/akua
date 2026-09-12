//! Shared multi-document YAML parsing for engine-callable output.
//!
//! Every Kubernetes-shaped rendering engine produces a multi-doc YAML
//! stream — one document per resource, separated by `---`. Parsing it
//! back into typed values is identical across callers (helm today,
//! kustomize next), so the logic lives here.

use std::borrow::Cow;

use serde_json::Value;

/// Parse a multi-document YAML byte slice into one `Value` per doc.
/// Empty separator docs (between resources) are dropped so callers
/// can splat the result directly into `resources`.
///
/// `plugin_name` prefixes error strings so a failure inside
/// `helm.template` looks different from one inside `kustomize.build`
/// when surfaced to a Package author.
pub(crate) fn parse(bytes: &[u8], plugin_name: &str) -> Result<Vec<Value>, String> {
    use serde::de::Deserialize;

    let text =
        std::str::from_utf8(bytes).map_err(|e| format!("{plugin_name}: output not utf-8: {e}"))?;
    let text = normalize_yaml_11_octal_scalars(text);

    let mut out = Vec::new();
    for doc in serde_yaml::Deserializer::from_str(&text) {
        let value = Value::deserialize(doc)
            .map_err(|e| format!("{plugin_name}: parsing output as YAML: {e}"))?;
        if is_empty_doc(&value) {
            continue;
        }
        out.push(value);
    }
    Ok(out)
}

fn normalize_yaml_11_octal_scalars(text: &str) -> Cow<'_, str> {
    // Helm emits Kubernetes manifests using YAML 1.1 scalar semantics, where a
    // leading-zero integer is octal. serde_yml follows YAML 1.2 and otherwise
    // turns values such as `defaultMode: 0755` into strings, which produces an
    // invalid Kubernetes JSON document. Normalize only unquoted plain scalars;
    // quoted and block-scalar content must retain their string meaning.
    let mut normalized = String::with_capacity(text.len());
    let mut changed = false;
    let mut block_scalar_indent = None;

    for line_with_ending in text.split_inclusive('\n') {
        let line = line_with_ending
            .strip_suffix('\n')
            .unwrap_or(line_with_ending);
        let line = line.strip_suffix('\r').unwrap_or(line);
        let ending = &line_with_ending[line.len()..];
        let indent = line.len() - line.trim_start_matches(' ').len();

        let inside_block_scalar = match block_scalar_indent {
            Some(parent_indent) if line.trim().is_empty() || indent > parent_indent => true,
            Some(_) => {
                block_scalar_indent = None;
                false
            }
            None => false,
        };

        if inside_block_scalar {
            normalized.push_str(line);
        } else if let Some(value_start) = mapping_value_start(line) {
            let value = &line[value_start..];
            let trimmed = value.trim_start();
            if starts_block_scalar(trimmed) {
                block_scalar_indent = Some(indent);
                normalized.push_str(line);
            } else if let Some((octal, token_len)) = legacy_octal_prefix(trimmed) {
                let leading = value.len() - trimmed.len();
                normalized.push_str(&line[..value_start + leading]);
                normalized.push_str(&octal.to_string());
                normalized.push_str(&trimmed[token_len..]);
                changed = true;
            } else {
                normalized.push_str(line);
            }
        } else {
            normalized.push_str(line);
        }
        normalized.push_str(ending);
    }

    if changed {
        Cow::Owned(normalized)
    } else {
        Cow::Borrowed(text)
    }
}

fn mapping_value_start(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut escaped = false;

    for (index, byte) in bytes.iter().copied().enumerate() {
        if double_quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                double_quoted = false;
            }
            continue;
        }
        if single_quoted {
            if byte == b'\'' {
                single_quoted = false;
            }
            continue;
        }
        match byte {
            b'"' => double_quoted = true,
            b'\'' => single_quoted = true,
            b':' if bytes.get(index + 1).is_none_or(u8::is_ascii_whitespace) => {
                return Some(index + 1);
            }
            _ => {}
        }
    }
    None
}

fn starts_block_scalar(value: &str) -> bool {
    matches!(value.as_bytes().first(), Some(b'|' | b'>'))
}

fn legacy_octal_prefix(value: &str) -> Option<(i64, usize)> {
    let bytes = value.as_bytes();
    let (negative, digits_start) = match bytes.first() {
        Some(b'-') => (true, 1),
        Some(b'+') => (false, 1),
        _ => (false, 0),
    };
    let digits = bytes.get(digits_start..)?;
    if digits.len() < 2 || digits.first() != Some(&b'0') {
        return None;
    }
    let digits_len = digits
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digits_len < 2
        || !digits[..digits_len]
            .iter()
            .all(|byte| matches!(byte, b'0'..=b'7'))
    {
        return None;
    }
    match digits.get(digits_len) {
        None | Some(b' ' | b'\t' | b'#' | b',' | b']' | b'}') => {}
        Some(_) => return None,
    }
    let magnitude =
        i64::from_str_radix(std::str::from_utf8(&digits[1..digits_len]).ok()?, 8).ok()?;
    let number = if negative { -magnitude } else { magnitude };
    Some((number, digits_start + digits_len))
}

fn is_empty_doc(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Object(m) => m.is_empty(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multi_doc_into_resource_list() {
        let text = br#"
apiVersion: v1
kind: ConfigMap
metadata:
  name: first
---
apiVersion: v1
kind: Service
metadata:
  name: second
"#;
        let docs = parse(text, "test").expect("parse");
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0]["kind"], "ConfigMap");
        assert_eq!(docs[1]["kind"], "Service");
    }

    #[test]
    fn parses_yaml_11_octal_scalars_as_numbers() {
        let text = br#"
apiVersion: apps/v1
kind: StatefulSet
spec:
  template:
    spec:
      volumes:
        - configMap:
            name: scripts
            defaultMode: 0755
        - secret:
            secretName: credentials
            defaultMode: "0755"
"#;

        let docs = parse(text, "helm.template").expect("parse");

        assert_eq!(
            docs[0]["spec"]["template"]["spec"]["volumes"][0]["configMap"]["defaultMode"],
            0o755
        );
        assert_eq!(
            docs[0]["spec"]["template"]["spec"]["volumes"][1]["secret"]["defaultMode"],
            "0755"
        );
    }

    #[test]
    fn drops_empty_separator_docs() {
        let text = b"---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n---\n---\n";
        let docs = parse(text, "test").expect("parse");
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0]["metadata"]["name"], "x");
    }

    #[test]
    fn empty_input_produces_empty_list() {
        assert_eq!(parse(b"", "test").unwrap(), Vec::<Value>::new());
        assert_eq!(parse(b"---\n", "test").unwrap(), Vec::<Value>::new());
    }

    #[test]
    fn invalid_utf8_surfaces_prefixed_error() {
        let e = parse(&[0xff, 0xfe, 0xfd], "pluginX").unwrap_err();
        assert!(e.starts_with("pluginX:"), "got: {e}");
        assert!(e.contains("not utf-8"));
    }

    /// A `|-` block scalar whose content contains a paragraph-separator
    /// (empty line) must parse without error and preserve the full value —
    /// the shape of temporal's `server-configmap.yaml`, where
    /// `config_template.yaml: |-` embeds multi-section YAML with bare empty
    /// lines. Locks in that the multi-doc parser handles it.
    ///
    /// NOTE: raw byte string (`br#"..."#`) is required to preserve the indentation
    /// of the block scalar. A non-raw `b"...\n\    persistence:"` would strip
    /// leading whitespace from the continuation line, producing invalid YAML.
    #[test]
    fn block_scalar_with_empty_line_parses_correctly() {
        let text = br#"---
apiVersion: v1
kind: ConfigMap
data:
  config_template.yaml: |-
    log:
      stdout: true
      level: "debug,info"

    persistence:
      defaultStore: default
"#;
        let docs = parse(text, "helm.template").unwrap_or_else(|e| {
            panic!("block scalar with paragraph-separator empty line should parse without error; got: {e}")
        });
        assert_eq!(docs.len(), 1, "expected exactly 1 ConfigMap doc");
        let config_val = docs[0]["data"]["config_template.yaml"]
            .as_str()
            .unwrap_or_else(|| {
                panic!(
                    "config_template.yaml should be a string value; got: {:?}",
                    docs[0]["data"]["config_template.yaml"]
                )
            });
        assert!(
            config_val.contains("persistence"),
            "block scalar content must preserve 'persistence' section after the empty line; \
             got: {config_val:?}"
        );
    }

    #[test]
    fn leaves_yaml_11_octal_text_inside_block_scalars_unchanged() {
        let text = br#"---
apiVersion: v1
kind: ConfigMap
data:
  example.yaml: |-
    defaultMode: 0755
"#;

        let docs = parse(text, "helm.template").expect("parse");

        assert_eq!(docs[0]["data"]["example.yaml"], "defaultMode: 0755");
    }

    /// Regression: real Helm multi-doc output (temporal chart, 59 documents total,
    /// 55 non-empty) must parse without error. The fixture contains block scalars
    /// with embedded shell pipe characters and `sed` patterns.
    #[test]
    fn parses_real_helm_multidoc_output() {
        let fixture = include_bytes!("../tests/fixtures/helm-multidoc.yaml");
        let docs = parse(fixture, "helm.template").unwrap_or_else(|e| {
            panic!("helm.template: failed to parse real helm output: {e}");
        });
        assert!(
            docs.len() >= 50,
            "expected ≥50 non-empty docs from temporal chart, got {}",
            docs.len()
        );
        for (i, doc) in docs.iter().enumerate() {
            assert!(
                doc.is_object(),
                "doc[{i}] is not a YAML mapping (got {doc:?})"
            );
        }
    }
}
