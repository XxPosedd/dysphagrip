"""Deploy the current Git commit to a Vultr Ubuntu VM over SSH."""

import argparse
from pathlib import Path
import re
import shlex
import subprocess
import tarfile
from tempfile import TemporaryDirectory


REPO = Path(__file__).resolve().parents[1]
REMOTE_INSTALL = """
set -eu
umask 077
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
tar -xzf - -C "$stage"
mkdir "$stage/app"
tar -xzf "$stage/source.tar.gz" -C "$stage/app"
sh "$stage/app/deploy/vultr-install.sh" "$stage"
"""


def brightdata_settings(file):
    required = ("BRIGHTDATA_API_TOKEN", "BRIGHTDATA_ZONE")
    selected = {}
    for line in file.read_text().splitlines():
        name, equals, value = line.strip().removeprefix("export ").partition("=")
        if equals and name.strip() in required:
            parts = shlex.split(value, comments=True)
            if len(parts) != 1 or not re.fullmatch(r"[A-Za-z0-9_.~+=:/-]+", parts[0]):
                raise ValueError(f"Invalid value for {name.strip()}")
            selected[name.strip()] = parts[0]
    for name in required:
        if name not in selected:
            raise ValueError(f"Missing {name} in the supplied settings file")
    return "".join(f"{key}={selected[key]}\n" for key in required)


def deploy(args):
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    with TemporaryDirectory(prefix="dysphagrip-deploy-") as temp:
        folder = Path(temp)
        source = folder / "source.tar.gz"
        subprocess.run(["git", "archive", "--format=tar.gz", "-o", source, revision,
                        "Dockerfile", ".dockerignore", "apps/web", "server", "deploy"], cwd=REPO, check=True)
        (folder / "revision").write_text(revision + "\n")
        if args.brightdata_env:
            (folder / "brightdata.env").write_text(brightdata_settings(args.brightdata_env))
        if args.domain:
            (folder / "site-address").write_text(args.domain.lower() + "\n")
        bundle = folder / "bundle.tar.gz"
        with tarfile.open(bundle, "w:gz") as package:
            for name in ("source.tar.gz", "revision", "brightdata.env", "site-address"):
                if (folder / name).is_file():
                    package.add(folder / name, arcname=name)
            if args.voice_dir:
                for phrase in ("started", "stopped"):
                    clip = args.voice_dir / (phrase + ".mp3")
                    with clip.open("rb") as f:
                        magic = f.read(3)
                    if not (magic == b"ID3" or len(magic) >= 2 and magic[0] == 255 and magic[1] & 224 == 224):
                        raise ValueError(f"Expected an MP3 in {clip}")
                    package.add(clip.resolve(), arcname=f"voice/{phrase}.mp3", recursive=False)

        ssh = ["ssh"]
        if args.ssh_key:
            ssh.extend(["-i", str(args.ssh_key), "-o", "IdentitiesOnly=yes"])
        # Only the fixed command travels through a remote shell. Credentials travel
        # inside the SSH stream, outside the Docker build context and command line.
        run_install = "if [ \"$(id -u)\" -eq 0 ]; then exec sh -c %s; else exec sudo -n sh -c %s; fi"
        command = run_install % ((shlex.quote(REMOTE_INSTALL),) * 2)
        with bundle.open("rb") as data:
            subprocess.run([*ssh, "--", args.host, command], stdin=data, check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host", help="SSH alias or root@public-IP")
    parser.add_argument("--ssh-key", type=Path, help="SSH private key for the Vultr VM")
    parser.add_argument("--domain", help="Domain already pointing to the VM, for automatic HTTPS")
    parser.add_argument("--brightdata-env", type=Path, help="Read the Bright Data token and zone from this .env file")
    parser.add_argument("--voice-dir", type=Path, help="Directory containing the two ElevenLabs clips started.mp3 and stopped.mp3")
    args = parser.parse_args()
    if args.host.startswith("-") or any(c.isspace() for c in args.host):
        parser.error("Use an SSH alias or a user@host address")
    if args.domain and not re.fullmatch(r"(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}", args.domain):
        parser.error("Pass a DNS name such as monitor.example.org to --domain")
    try:
        deploy(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"Deployment failed: {exc}\n")
