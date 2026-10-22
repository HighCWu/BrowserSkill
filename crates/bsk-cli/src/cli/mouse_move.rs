//! `bsk mouse-move` — glide the pointer along a humanised trajectory.

use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{MouseCurve, MouseMoveParams, MouseMoveResult};
use clap::{Args, ValueEnum};

use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::navigate::parse_timeout_ms;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum CliMouseCurve {
    Bezier,
    Linear,
}

impl From<CliMouseCurve> for MouseCurve {
    fn from(v: CliMouseCurve) -> Self {
        match v {
            CliMouseCurve::Bezier => MouseCurve::Bezier,
            CliMouseCurve::Linear => MouseCurve::Linear,
        }
    }
}

#[derive(Debug, Clone, Args)]
pub struct MouseMoveArgs {
    /// Destination X in viewport CSS pixels.
    #[arg(long = "x", value_name = "X")]
    pub x: f64,

    /// Destination Y in viewport CSS pixels.
    #[arg(long = "y", value_name = "Y")]
    pub y: f64,

    /// Start X. Requires `--from-y`; omit both to start from the tab's
    /// last pointer position (or the viewport centre).
    #[arg(long = "from-x", value_name = "X")]
    pub from_x: Option<f64>,

    /// Start Y. Requires `--from-x`.
    #[arg(long = "from-y", value_name = "Y")]
    pub from_y: Option<f64>,

    /// Approximate move duration. Defaults to an adaptive 350–950 ms
    /// based on travel distance.
    #[arg(long = "duration-ms", value_parser = clap::value_parser!(u32).range(1..))]
    pub duration_ms: Option<u32>,

    /// Number of dispatched move points. Defaults to `duration / 12`
    /// clamped to 12–80.
    #[arg(long, value_parser = clap::value_parser!(u32).range(2..))]
    pub steps: Option<u32>,

    /// Path shape (`bezier` default, or `linear`).
    #[arg(long, value_enum)]
    pub curve: Option<CliMouseCurve>,

    /// Force the overshoot-and-correct behaviour on or off. Defaults to
    /// a random ~12% chance.
    #[arg(long, value_parser = parse_on_off, value_name = "on|off")]
    pub overshoot: Option<bool>,

    #[arg(long)]
    pub session: String,

    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

/// Parse `--overshoot on|off` (case-insensitive).
fn parse_on_off(value: &str) -> Result<bool, String> {
    match value.to_lowercase().as_str() {
        "on" | "true" | "yes" => Ok(true),
        "off" | "false" | "no" => Ok(false),
        other => Err(format!("invalid --overshoot value '{other}'; use on or off")),
    }
}

/// Local validation of endpoint pairs, mirroring the wire contract.
fn validate_points(args: &MouseMoveArgs) -> Result<(), CliError> {
    if !args.x.is_finite() || !args.y.is_finite() {
        return Err(CliError::Local(anyhow::anyhow!(
            "mouse-move --x/--y must be finite numbers"
        )));
    }
    match (args.from_x, args.from_y) {
        (None, None) => Ok(()),
        (Some(fx), Some(fy)) if fx.is_finite() && fy.is_finite() => Ok(()),
        (Some(_), Some(_)) => Err(CliError::Local(anyhow::anyhow!(
            "mouse-move --from-x/--from-y must be finite numbers"
        ))),
        _ => Err(CliError::Local(anyhow::anyhow!(
            "mouse-move --from-x and --from-y must be provided together"
        ))),
    }
}

pub fn dispatch(args: MouseMoveArgs, format: Format) -> Result<(), CliError> {
    validate_points(&args)?;
    let info = ensure_daemon().context("ensure daemon is running")?;
    let params = MouseMoveParams {
        session_id: args.session.clone(),
        to_x: args.x,
        to_y: args.y,
        from_x: args.from_x,
        from_y: args.from_y,
        duration_ms: args.duration_ms,
        steps: args.steps,
        curve: args.curve.map(Into::into),
        overshoot: args.overshoot,
        jitter: None,
        tab_id: args.tab_id,
        timeout_ms: Some(args.timeout),
    };
    let reply: MouseMoveResult = crate::cli::business_rpc::call(
        info.sock_path,
        "mouse-move-1",
        Method::ToolMouseMove,
        Some(params),
        ipc_timeout(args.timeout),
    )?;
    match format {
        Format::Json => println!(
            "{}",
            serde_json::to_string_pretty(&reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
        ),
        Format::Human => {
            println!(
                "mouse-move ok tab={} from=({}, {}) to=({}, {}) steps={} duration={}ms curve={} overshoot={}",
                reply.tab_id,
                reply.from_x,
                reply.from_y,
                reply.x,
                reply.y,
                reply.steps,
                reply.duration_ms,
                match reply.curve {
                    MouseCurve::Bezier => "bezier",
                    MouseCurve::Linear => "linear",
                },
                if reply.overshoot { "yes" } else { "no" },
            );
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms))
        .checked_add(Duration::from_secs(15))
        .unwrap_or(Duration::from_secs(u64::from(timeout_ms / 1_000) + 15))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_args() -> MouseMoveArgs {
        MouseMoveArgs {
            x: 800.0,
            y: 400.0,
            from_x: None,
            from_y: None,
            duration_ms: None,
            steps: None,
            curve: None,
            overshoot: None,
            session: "s1".into(),
            tab_id: None,
            timeout: 30_000,
        }
    }

    #[test]
    fn parse_on_off_accepts_common_spellings() {
        assert_eq!(parse_on_off("on"), Ok(true));
        assert_eq!(parse_on_off("OFF"), Ok(false));
        assert_eq!(parse_on_off("yes"), Ok(true));
        assert_eq!(parse_on_off("no"), Ok(false));
        assert!(parse_on_off("maybe").is_err());
    }

    #[test]
    fn endpoint_pairs_must_be_complete_and_finite() {
        let mut args = base_args();
        assert!(validate_points(&args).is_ok());
        args.from_x = Some(10.0);
        assert!(validate_points(&args).is_err(), "--from-x alone is invalid");
        args.from_y = Some(20.0);
        assert!(validate_points(&args).is_ok());
        args.from_x = Some(f64::NAN);
        assert!(validate_points(&args).is_err(), "non-finite from is invalid");
        args.from_x = Some(10.0);
        args.x = f64::INFINITY;
        assert!(validate_points(&args).is_err(), "non-finite destination is invalid");
    }

    #[test]
    fn rejects_invalid_commands_before_starting_the_daemon() {
        use crate::cli::{Cli, Command};
        use clap::Parser;
        // Missing --x or --y fails at parse time; a bad --overshoot value
        // fails at parse time too.
        assert!(Cli::try_parse_from(["bsk", "mouse-move", "--y", "10", "--session", "s1"]).is_err());
        assert!(Cli::try_parse_from(["bsk", "mouse-move", "--x", "10", "--session", "s1"]).is_err());
        assert!(
            Cli::try_parse_from([
                "bsk",
                "mouse-move",
                "--x",
                "10",
                "--y",
                "20",
                "--session",
                "s1",
                "--overshoot",
                "maybe"
            ])
            .is_err()
        );
        // A complete parse still gets validated locally before the daemon
        // is contacted.
        let Command::MouseMove(args) =
            Cli::try_parse_from(["bsk", "mouse-move", "--x", "10", "--y", "20", "--session", "s1"])
                .unwrap()
                .command
        else {
            panic!("mouse-move");
        };
        assert!(matches!(dispatch(args, Format::Json), Err(CliError::Local(_))));
    }
}
