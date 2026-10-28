"""Harbor environment for Laminar hosted evals.

Written next to the job config by `lmnr-cli eval run --remote` and loaded with
`environment.import_path = "lmnr_hosted_env:LaminarEnvironment"`. Each trial
runs in a Daytona sandbox that the Laminar app-server creates and proxies, so
this process only ever holds a Laminar project API key.

Configuration (set by lmnr-cli):
  LMNR_PROJECT_API_KEY  project API key the sandbox routes authenticate with
  LMNR_BASE_URL         Laminar API URL, optionally with a port
  LMNR_EVAL_IMAGES      JSON image map: {"images": {docker_image: spec},
                        "dockerfiles": {env dir relative to cwd: spec}}, where
                        spec is {"dockerfile": str, "contextHashes": [str]}
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import shlex
import tempfile
import time
from pathlib import Path
from uuid import uuid4

import httpx

from harbor.environments.base import BaseEnvironment, ExecResult, SandboxBuildFailedError
from harbor.environments.capabilities import (
    EnvironmentCapabilities,
    EnvironmentResourceCapabilities,
)
from harbor.environments.definition import should_use_prebuilt_docker_image
from harbor.environments.tar_transfer import (
    extract_dir_from_file,
    pack_dir_to_file,
    remote_pack_command,
    remote_unpack_command,
)

ENVIRONMENT_TYPE = "laminar"
DEFAULT_BASE_URL = "https://api.lmnr.ai"
REQUEST_TIMEOUT = httpx.Timeout(300.0, connect=30.0)
REQUEST_ATTEMPTS = 4
FAILED_STATES = {"error", "build_failed", "destroyed", "destroying"}
# A command can outlive its own `timeout` while the sandbox is torn down; give
# up polling this long after it should have ended.
POLL_GRACE_SEC = 300


class LaminarEnvironmentError(RuntimeError):
    pass


def _base_url() -> str:
    return (os.environ.get("LMNR_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


def _image_map() -> dict:
    raw = os.environ.get("LMNR_EVAL_IMAGES")
    return json.loads(raw) if raw else {}


class LaminarEnvironment(BaseEnvironment):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        api_key = os.environ.get("LMNR_PROJECT_API_KEY")
        if not api_key:
            raise LaminarEnvironmentError(
                "LMNR_PROJECT_API_KEY is not set; lmnr-cli passes it to Harbor."
            )
        self._api = f"{_base_url()}/v1/hosted-evals"
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._client: httpx.AsyncClient | None = None
        self._sandbox_id: str | None = None

    @staticmethod
    def type() -> str:
        return ENVIRONMENT_TYPE

    @classmethod
    def resource_capabilities(cls) -> EnvironmentResourceCapabilities:
        return EnvironmentResourceCapabilities(cpu_request=True, memory_request=True)

    @property
    def capabilities(self) -> EnvironmentCapabilities:
        return EnvironmentCapabilities()

    def _validate_definition(self):
        if (self.environment_dir / "docker-compose.yaml").exists():
            raise LaminarEnvironmentError(
                "docker-compose tasks aren't supported by Laminar hosted evals; "
                "run every service in one image."
            )
        if not self.task_env_config.docker_image and not (
            self.environment_dir / "Dockerfile"
        ).exists():
            raise FileNotFoundError(
                f"{self.environment_dir} has no Dockerfile and its task sets no docker_image."
            )

    # ---- HTTP ----

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(headers=self._headers, timeout=REQUEST_TIMEOUT)
        return self._client

    async def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        last_error: Exception | None = None
        for attempt in range(REQUEST_ATTEMPTS):
            try:
                response = await self._http().request(method, f"{self._api}{path}", **kwargs)
            except httpx.TransportError as e:
                last_error = e
            else:
                if response.status_code < 500 and response.status_code != 429:
                    return response
                last_error = LaminarEnvironmentError(_error_message(response))
            await asyncio.sleep(min(2**attempt, 10))
        raise LaminarEnvironmentError(f"{method} {path} failed: {last_error}")

    async def _json(self, method: str, path: str, **kwargs) -> dict:
        response = await self._request(method, path, **kwargs)
        if response.is_error:
            raise LaminarEnvironmentError(f"{method} {path}: {_error_message(response)}")
        return response.json() if response.content else {}

    def _sandbox_path(self, suffix: str = "") -> str:
        if self._sandbox_id is None:
            raise LaminarEnvironmentError("Sandbox not started.")
        return f"/sandboxes/{self._sandbox_id}{suffix}"

    # ---- Lifecycle ----

    def _image_spec(self, force_build: bool) -> dict:
        images = _image_map()
        docker_image = self.task_env_config.docker_image
        if docker_image and should_use_prebuilt_docker_image(
            self.environment_dir, docker_image=docker_image, force_build=force_build
        ):
            # Images not built by lmnr-cli are pulled from their registry.
            return images.get("images", {}).get(docker_image) or {
                "dockerfile": f"FROM {docker_image}\n",
                "contextHashes": [],
            }
        # lmnr-cli writes the keys with "/" on every OS (`dockerfileKey`).
        key = Path(os.path.relpath(self.environment_dir, Path.cwd())).as_posix()
        spec = images.get("dockerfiles", {}).get(key)
        if spec is None:
            raise LaminarEnvironmentError(
                f"lmnr-cli didn't upload a build context for {key}/Dockerfile."
            )
        return spec

    def _resources(self) -> dict:
        resources = {}
        if (cpus := self._effective_cpus) is not None:
            resources["cpus"] = max(1, math.ceil(cpus))
        if (memory_mb := self._effective_memory_mb) is not None:
            resources["memoryGb"] = max(1, math.ceil(memory_mb / 1024))
        if (storage_mb := self._effective_storage_mb) is not None:
            resources["diskGb"] = max(1, math.ceil(storage_mb / 1024))
        return resources

    async def start(self, force_build: bool) -> None:
        body = {**self._image_spec(force_build), **self._resources()}
        created = await self._json("POST", "/sandboxes", json=body)
        self._sandbox_id = created["sandboxId"]
        self.logger.debug("Created Laminar sandbox %s", self._sandbox_id)
        await self._wait_until_started()

        workdir = self.task_env_config.workdir
        if workdir:
            await self.exec(self._ensure_dirs_command([workdir], chmod=False), user="root")
        await self.ensure_dirs(self._mount_targets(writable_only=True))
        await self._upload_environment_dir_after_start()

    async def _wait_until_started(self) -> None:
        timeout = float(getattr(self.task_env_config, "build_timeout_sec", None) or 1800)
        deadline = time.monotonic() + timeout
        while True:
            status = await self._json("GET", self._sandbox_path())
            state = status.get("state")
            if state == "started":
                return
            if state in FAILED_STATES:
                reason = status.get("errorReason") or state
                if state == "build_failed":
                    raise SandboxBuildFailedError(
                        f"Image build failed for '{self.environment_name}': {reason}"
                    )
                raise LaminarEnvironmentError(f"Sandbox {self._sandbox_id} is {state}: {reason}")
            if time.monotonic() > deadline:
                raise LaminarEnvironmentError(
                    f"Sandbox {self._sandbox_id} did not start within {timeout:.0f}s (state {state})"
                )
            await asyncio.sleep(2)

    async def _upload_environment_dir_after_start(self) -> None:
        await super()._upload_environment_dir_after_start()

    async def stop(self, delete: bool):
        try:
            if self._sandbox_id is None:
                return
            if not delete:
                self.logger.info("Keeping Laminar sandbox %s (delete=False)", self._sandbox_id)
                return
            response = await self._request("DELETE", self._sandbox_path())
            if response.is_error and response.status_code != 404:
                self.logger.error(
                    "Failed to delete sandbox %s: %s", self._sandbox_id, _error_message(response)
                )
        finally:
            self._sandbox_id = None
            if self._client is not None:
                await self._client.aclose()
                self._client = None

    # ---- Commands ----

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        # Same composition as Harbor's Daytona environment.
        command = f"bash -c {shlex.quote(command)}"
        if env := self._merge_env(env):
            env_args = " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items())
            command = f"env {env_args} {command}"
        if timeout_sec:
            command = f"timeout {timeout_sec} {command}"
        if cwd:
            command = f"cd {shlex.quote(cwd)} && {command}"
        user = self._resolve_user(user)
        if user is not None:
            user_arg = (
                f"$(getent passwd {user} | cut -d: -f1)"
                if isinstance(user, int)
                else shlex.quote(user)
            )
            command = f"su {user_arg} -s /bin/bash -c {shlex.quote(command)}"

        started = await self._json("POST", self._sandbox_path("/commands"), json={"command": command})
        command_id = started["commandId"]
        deadline = (
            time.monotonic() + timeout_sec + POLL_GRACE_SEC if timeout_sec else None
        )
        delay = 0.5
        while True:
            result = await self._json("GET", self._sandbox_path(f"/commands/{command_id}"))
            if result.get("exitCode") is not None:
                return ExecResult(
                    stdout=result.get("stdout") or "",
                    stderr=result.get("stderr") or "",
                    return_code=int(result["exitCode"]),
                )
            if deadline is not None and time.monotonic() > deadline:
                raise LaminarEnvironmentError(
                    f"Command did not finish within {timeout_sec}s in sandbox {self._sandbox_id}"
                )
            await asyncio.sleep(delay)
            delay = min(delay * 1.5, 3.0)

    # ---- Files ----

    async def upload_file(self, source_path: Path | str, target_path: str):
        content = Path(source_path).read_bytes()
        await self._json(
            "PUT", self._sandbox_path("/files"), params={"path": target_path}, content=content
        )

    async def download_file(self, source_path: str, target_path: Path | str):
        response = await self._request(
            "GET", self._sandbox_path("/files"), params={"path": source_path}
        )
        if response.is_error:
            raise LaminarEnvironmentError(
                f"Download of {source_path} failed: {_error_message(response)}"
            )
        target = Path(target_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(response.content)

    async def upload_dir(self, source_dir: Path | str, target_dir: str):
        remote_archive = f"/tmp/lmnr_upload_{uuid4().hex}.tar.gz"
        with tempfile.TemporaryDirectory() as tmp_dir:
            archive = Path(tmp_dir) / "upload.tar.gz"
            pack_dir_to_file(source_dir, archive)
            await self.upload_file(archive, remote_archive)
        try:
            result = await self.exec(
                remote_unpack_command(remote_archive, target_dir), timeout_sec=600, user="root"
            )
            if result.return_code != 0:
                raise LaminarEnvironmentError(
                    f"Failed to extract into {target_dir} (images need tar and gzip): {result.stderr}"
                )
        finally:
            await self.exec(f"rm -f {shlex.quote(remote_archive)}", timeout_sec=30, user="root")

    async def download_dir(self, source_dir: str, target_dir: Path | str):
        remote_archive = f"/tmp/lmnr_download_{uuid4().hex}.tar.gz"
        target = Path(target_dir)
        target.mkdir(parents=True, exist_ok=True)
        try:
            result = await self.exec(
                remote_pack_command(source_dir, remote_archive), timeout_sec=600, user="root"
            )
            if result.return_code != 0:
                raise LaminarEnvironmentError(
                    f"Failed to archive {source_dir} (images need tar and gzip): {result.stderr}"
                )
            with tempfile.TemporaryDirectory() as tmp_dir:
                archive = Path(tmp_dir) / "download.tar.gz"
                await self.download_file(remote_archive, archive)
                extract_dir_from_file(archive, target)
        finally:
            await self.exec(f"rm -f {shlex.quote(remote_archive)}", timeout_sec=30, user="root")


def _error_message(response: httpx.Response) -> str:
    try:
        error = response.json().get("error")
    except (ValueError, AttributeError):
        error = None
    return f"{response.status_code} {error or response.text[:500]}"
