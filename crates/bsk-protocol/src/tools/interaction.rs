//! DOM interaction tools (`tool.click`, `tool.hover`, `tool.focus`,
//! `tool.blur`, `tool.fill`, `tool.press`, `tool.select`).
//!
//! Element-targeted tools accept either a snapshot `ref` (`@e<N>` form,
//! normalised against the session's RefStore) **or** a CSS selector
//! resolved at call time. Modifiers / mouse buttons are encoded as
//! lowercase JSON strings so the same wire shape works for CLI flags and
//! the extension's CDP bridge.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::JavaScriptDialogInfo;

/// Keyboard modifier flags. Multiple flags may be combined; the
/// extension folds them into CDP's bitfield (`alt=1, ctrl=2, meta=4,
/// shift=8`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum KeyModifier {
    Alt,
    Ctrl,
    Meta,
    Shift,
}

/// Mouse button selector for `tool.click`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    #[default]
    Left,
    Middle,
    Right,
}

/// Path shape for a humanised mouse move (`tool.mouse_move`, or the
/// `glide` option of `tool.hover` / `tool.click`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MouseCurve {
    /// Cubic Bézier through two random control points offset
    /// perpendicular to the start–end line (default).
    #[default]
    Bezier,
    /// Straight line between start and end.
    Linear,
}

// ---------------------------------------------------------------------------
// click
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ClickParams {
    /// Single-use capture returned by a visual-ref screenshot; requires image coordinates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_y: Option<f64>,
    pub session_id: String,
    /// Optional `@e<N>` ref allocated by the last `tool.snapshot`.
    /// Mutually exclusive with `selector` (caller must supply exactly
    /// one). Accepts both `"e3"` and `"@e3"`.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Viewport-relative X coordinate (CSS pixels). When both `x` and
    /// `y` are supplied the click is dispatched at this point without
    /// resolving an element; both must be given together and neither
    /// may be combined with `ref`/`selector`/`capture_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    /// Viewport-relative Y coordinate (CSS pixels). See `x`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<MouseButton>,
    /// Number of consecutive mouse presses (double-click = 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub click_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<KeyModifier>>,
    /// Glide the pointer to the click point along a humanised trajectory
    /// instead of teleporting. Mutually exclusive with `capture_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glide: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ClickResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// Viewport-relative click coordinates (CSS pixels). Reported so
    /// agents can correlate with a follow-up `tool.screenshot`.
    pub x: f64,
    pub y: f64,
    /// Native JS dialogs observed and auto-handled during this call.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// hover
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HoverParams {
    pub session_id: String,
    /// Optional `@e<N>` ref allocated by the last observation.
    /// Mutually exclusive with `selector` and with `x`/`y`.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    /// Mutually exclusive with `ref` and with `x`/`y`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Viewport-relative X coordinate (CSS pixels). When both `x` and
    /// `y` are supplied the mouse moves straight to this point without
    /// resolving an element; both must be given together and neither
    /// may be combined with `ref`/`selector`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    /// Viewport-relative Y coordinate (CSS pixels). See `x`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<KeyModifier>>,
    /// Wait after the mouse move so hover-triggered UI can settle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0))]
    pub settle_ms: Option<u32>,
    /// Glide the pointer to the target along a humanised trajectory
    /// instead of moving in a single step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glide: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HoverResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// Viewport-relative hover coordinates (CSS pixels).
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// mouse_move
// ---------------------------------------------------------------------------

/// Move the pointer along a humanised trajectory (`tool.mouse_move`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MouseMoveParams {
    pub session_id: String,
    /// Destination X in top-level viewport CSS pixels.
    #[serde(default)]
    pub to_x: f64,
    /// Destination Y in top-level viewport CSS pixels.
    #[serde(default)]
    pub to_y: f64,
    /// Start X. Both `from_*` fields must be given together; when
    /// omitted the trajectory starts at the pointer's last known
    /// position on the tab, or the viewport centre if none is recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_x: Option<f64>,
    /// Start Y. See `from_x`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_y: Option<f64>,
    /// Approximate wall-clock duration of the move. Defaults to an
    /// adaptive value between 350–950 ms based on travel distance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub duration_ms: Option<u32>,
    /// Number of dispatched move points (including the destination).
    /// Defaults to `duration_ms / 12` clamped to 12–80.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 2))]
    pub steps: Option<u32>,
    /// Path shape. Defaults to `bezier`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curve: Option<MouseCurve>,
    /// Overshoot the destination by 2–8% of the travel distance and
    /// glide back. Defaults to a random ~12% chance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overshoot: Option<bool>,
    /// Add ±0.5 px per-point noise. Defaults to `true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jitter: Option<bool>,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MouseMoveResult {
    pub tab_id: i64,
    /// Start point the trajectory actually used.
    pub from_x: f64,
    pub from_y: f64,
    /// Final dispatch point (equals the requested destination).
    pub x: f64,
    pub y: f64,
    /// Number of `mouseMoved` events dispatched, including overshoot
    /// return steps.
    pub steps: u32,
    /// Planned trajectory duration: the sum of the per-point sleeps.
    pub duration_ms: u32,
    /// Whether an overshoot-and-correct segment was used.
    pub overshoot: bool,
    pub curve: MouseCurve,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// focus / blur
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FocusParams {
    pub session_id: String,
    /// Optional `@e<N>` ref allocated by the last observation.
    /// Mutually exclusive with `selector`.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FocusResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// Whether the target holds DOM focus in its document or shadow root after the call.
    pub focused: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BlurParams {
    pub session_id: String,
    /// Optional `@e<N>` ref allocated by the last observation.
    /// Mutually exclusive with `selector`.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BlurResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// Whether the target held focus before the call.
    pub was_focused: bool,
    /// Always false for a successful blur; included for machine verification.
    pub focused: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// fill
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FillParams {
    pub session_id: String,
    pub value: String,
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Clear the field before typing. Defaults to `true`; pass `false`
    /// to append instead of replacing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_before: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FillResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// UTF-16 code-unit length of the value that was finally typed
    /// (matches what `input.value.length` would report in the page).
    pub value_length: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// press
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PressParams {
    pub session_id: String,
    /// Logical key name. Accepts CDP `key` strings (`Enter`, `Escape`,
    /// `ArrowDown`, single characters like `a`), or a compound
    /// expression such as `Ctrl+A` / `Meta+Shift+P`. Modifiers in the
    /// compound form combine with anything supplied via `modifiers`.
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<KeyModifier>>,
    /// Optional target to focus before dispatching the key.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Hold the key down for this many milliseconds between `keyDown`
    /// and `keyUp`. Useful for testing long-press handlers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PressResult {
    pub tab_id: i64,
    pub key: String,
    pub code: String,
    #[serde(default)]
    pub modifiers: Vec<KeyModifier>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SelectParams {
    pub session_id: String,
    /// Option `value` strings to set as the final selection. For a
    /// single-select `<select>` exactly one value is required; for
    /// `<select multiple>` the list replaces the current selection
    /// (an empty list clears all selections).
    pub values: Vec<String>,
    /// Optional `@e<N>` ref allocated by the last `tool.snapshot`.
    /// Mutually exclusive with `selector`. Accepts both `"e3"` and
    /// `"@e3"`.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    /// CSS selector resolved against the live DOM. Mutually exclusive
    /// with `ref_`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Maximum time the daemon waits for the tool call before timing out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SelectResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// Whether the target `<select>` had the `multiple` attribute.
    pub multiple: bool,
    /// Final selected option `value` attributes after the call.
    pub selected_values: Vec<String>,
    /// Visible labels of the selected options (same order as
    /// `selected_values`).
    pub selected_labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn click_params_serialise_ref_field_name() {
        let p = ClickParams {
            capture_id: None,
            image_x: None,
            image_y: None,
            session_id: "abcd".into(),
            ref_: Some("@e3".into()),
            selector: None,
            x: None,
            y: None,
            tab_id: Some(42),
            button: Some(MouseButton::Left),
            click_count: Some(1),
            modifiers: Some(vec![KeyModifier::Ctrl]),
            glide: None,
            timeout_ms: Some(5_000),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("ref").and_then(|v| v.as_str()), Some("@e3"));
        assert!(v.get("ref_").is_none());
        let round: ClickParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn click_params_serialise_glide_and_omit_when_absent() {
        let p = ClickParams {
            capture_id: None,
            image_x: None,
            image_y: None,
            session_id: "abcd".into(),
            ref_: Some("@e3".into()),
            selector: None,
            x: None,
            y: None,
            tab_id: None,
            button: None,
            click_count: None,
            modifiers: None,
            glide: Some(true),
            timeout_ms: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("glide"), Some(&serde_json::json!(true)));
        let round: ClickParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);

        let plain = ClickParams {
            glide: None,
            ..p
        };
        let v = serde_json::to_value(&plain).unwrap();
        assert!(v.get("glide").is_none());
    }

    #[test]
    fn click_params_round_trip_coordinates() {
        let p = ClickParams {
            capture_id: None,
            image_x: None,
            image_y: None,
            session_id: "abcd".into(),
            ref_: None,
            selector: None,
            x: Some(512.5),
            y: Some(384.0),
            tab_id: None,
            button: None,
            click_count: None,
            modifiers: None,
            glide: Some(true),
            timeout_ms: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("x"), Some(&serde_json::json!(512.5)));
        assert_eq!(v.get("y"), Some(&serde_json::json!(384.0)));
        let round: ClickParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn click_params_accept_legacy_ref_alias() {
        let p: ClickParams = serde_json::from_value(json!({
            "session_id": "a",
            "ref_": "e1",
            "selector": null,
        }))
        .unwrap();
        assert_eq!(p.ref_.as_deref(), Some("e1"));
    }

    #[test]
    fn hover_params_serialise_ref_field_name() {
        let p = HoverParams {
            session_id: "abcd".into(),
            ref_: Some("@e3".into()),
            selector: None,
            x: None,
            y: None,
            tab_id: Some(42),
            modifiers: Some(vec![KeyModifier::Shift]),
            settle_ms: Some(200),
            glide: None,
            timeout_ms: Some(5_000),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("ref").and_then(|v| v.as_str()), Some("@e3"));
        assert!(v.get("ref_").is_none());
        let round: HoverParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn hover_params_serialise_glide_and_omit_when_absent() {
        let p = HoverParams {
            session_id: "abcd".into(),
            ref_: None,
            selector: None,
            x: None,
            y: None,
            tab_id: None,
            modifiers: None,
            settle_ms: None,
            glide: Some(true),
            timeout_ms: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("glide"), Some(&serde_json::json!(true)));
        let round: HoverParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
        let plain = HoverParams { glide: None, ..p };
        let v = serde_json::to_value(&plain).unwrap();
        assert!(v.get("glide").is_none());
    }

    #[test]
    fn hover_params_omit_coordinates_when_absent() {
        let p = HoverParams {
            session_id: "abcd".into(),
            ref_: None,
            selector: None,
            x: None,
            y: None,
            tab_id: None,
            modifiers: None,
            settle_ms: None,
            glide: None,
            timeout_ms: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("x").is_none());
        assert!(v.get("y").is_none());
        let round: HoverParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn hover_params_round_trip_coordinates() {
        let p = HoverParams {
            session_id: "abcd".into(),
            ref_: None,
            selector: None,
            x: Some(512.5),
            y: Some(384.0),
            tab_id: None,
            modifiers: None,
            settle_ms: Some(200),
            glide: None,
            timeout_ms: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("x"), Some(&serde_json::json!(512.5)));
        assert_eq!(v.get("y"), Some(&serde_json::json!(384.0)));
        let round: HoverParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn mouse_move_params_round_trip_full_shape() {
        let p = MouseMoveParams {
            session_id: "abcd".into(),
            to_x: 800.0,
            to_y: 400.0,
            from_x: Some(10.5),
            from_y: Some(20.0),
            duration_ms: Some(700),
            steps: Some(48),
            curve: Some(MouseCurve::Linear),
            overshoot: Some(false),
            jitter: Some(false),
            tab_id: Some(7),
            timeout_ms: Some(9_000),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("to_x"), Some(&serde_json::json!(800.0)));
        assert_eq!(v.get("curve"), Some(&serde_json::json!("linear")));
        let round: MouseMoveParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn mouse_move_params_omit_optional_fields() {
        let p = MouseMoveParams {
            session_id: "abcd".into(),
            to_x: 12.0,
            to_y: 34.0,
            from_x: None,
            from_y: None,
            duration_ms: None,
            steps: None,
            curve: None,
            overshoot: None,
            jitter: None,
            tab_id: None,
            timeout_ms: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        for field in [
            "from_x",
            "from_y",
            "duration_ms",
            "steps",
            "curve",
            "overshoot",
            "jitter",
            "tab_id",
            "timeout_ms",
        ] {
            assert!(v.get(field).is_none(), "{field} should be omitted");
        }
        let round: MouseMoveParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn mouse_move_params_default_curve_is_bezier() {
        let p: MouseMoveParams = serde_json::from_value(serde_json::json!({
            "session_id": "abcd",
            "to_x": 1.0,
            "to_y": 2.0
        }))
        .unwrap();
        assert_eq!(p.curve, None);
        assert_eq!(MouseCurve::default(), MouseCurve::Bezier);
    }

    #[test]
    fn mouse_move_result_round_trips_stats() {
        let r = MouseMoveResult {
            tab_id: 9,
            from_x: 640.0,
            from_y: 360.0,
            x: 800.0,
            y: 400.0,
            steps: 42,
            duration_ms: 613,
            overshoot: true,
            curve: MouseCurve::Bezier,
            dialogs: vec![],
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v.get("steps"), Some(&serde_json::json!(42)));
        assert_eq!(v.get("duration_ms"), Some(&serde_json::json!(613)));
        assert_eq!(v.get("overshoot"), Some(&serde_json::json!(true)));
        let round: MouseMoveResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }

    #[test]
    fn focus_params_serialise_ref_field_name() {
        let p = FocusParams {
            session_id: "abcd".into(),
            ref_: Some("@e4".into()),
            selector: None,
            tab_id: Some(42),
            timeout_ms: Some(5_000),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("ref").and_then(|v| v.as_str()), Some("@e4"));
        assert!(v.get("ref_").is_none());
        let round: FocusParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn blur_result_round_trips_focus_state() {
        let result = BlurResult {
            tab_id: 42,
            used_ref: Some("e4".into()),
            used_selector: None,
            was_focused: true,
            focused: false,
            dialogs: vec![],
        };
        let value = serde_json::to_value(&result).unwrap();
        let round: BlurResult = serde_json::from_value(value).unwrap();
        assert_eq!(round, result);
    }

    #[test]
    fn modifiers_render_as_lowercase_strings() {
        let v = serde_json::to_value(KeyModifier::Ctrl).unwrap();
        assert_eq!(v, json!("ctrl"));
        let v = serde_json::to_value(KeyModifier::Meta).unwrap();
        assert_eq!(v, json!("meta"));
    }

    #[test]
    fn press_result_round_trips() {
        let r = PressResult {
            tab_id: 5,
            key: "a".into(),
            code: "KeyA".into(),
            modifiers: vec![KeyModifier::Ctrl, KeyModifier::Shift],
            dialogs: vec![],
        };
        let v = serde_json::to_value(&r).unwrap();
        let round: PressResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }

    #[test]
    fn fill_params_default_clear_before_is_omitted() {
        let p = FillParams {
            session_id: "abcd".into(),
            value: "hello".into(),
            ref_: Some("@e1".into()),
            selector: None,
            tab_id: None,
            clear_before: None,
            timeout_ms: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("clear_before").is_none());
    }

    #[test]
    fn select_params_round_trips_values() {
        let p = SelectParams {
            session_id: "abcd".into(),
            values: vec!["us".into(), "ca".into()],
            ref_: Some("@e3".into()),
            selector: None,
            tab_id: Some(12),
            timeout_ms: Some(5_000),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("values").cloned(), Some(json!(["us", "ca"])));
        let round: SelectParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }
}
