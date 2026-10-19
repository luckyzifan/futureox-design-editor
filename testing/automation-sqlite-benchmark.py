#!/usr/bin/env python3
"""CPU-only POSIX benchmark of the real desktop stdio/SQLite metadata route.

Uses a private disposable workspace with synthetic metadata; never opens a user
document. Latencies include serialization, pipe roundtrip and SQLite commit.
"""
import argparse
import json
import math
import os
from pathlib import Path
import platform
import resource
import selectors
import subprocess
import tempfile
import time


def stats(values):
    ordered = sorted(values)
    return {"samples": len(values), "p50Ms": round(ordered[math.ceil(len(values) * .5) - 1], 3),
            "p95Ms": round(ordered[math.ceil(len(values) * .95) - 1], 3),
            "maxMs": round(ordered[-1], 3), "meanMs": round(sum(values) / len(values), 3)}


class Backend:
    def __init__(self, binary, directory):
        self.process = subprocess.Popen(
            [str(binary), "--recovery-dir", str(directory / "recovery"),
             "--catalog-db", str(directory / "catalog.sqlite3"),
             "--workspace-db", str(directory / "workspace.sqlite3")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.sequence = 0

    def call(self, method, params):
        self.sequence += 1
        start = time.perf_counter_ns()
        self.process.stdin.write(json.dumps({"id": self.sequence, "method": method, "params": params}) + "\n")
        self.process.stdin.flush()
        if not self.selector.select(10):
            raise TimeoutError("Desktop metadata roundtrip exceeded 10 seconds")
        line = self.process.stdout.readline()
        result = json.loads(line)
        elapsed = (time.perf_counter_ns() - start) / 1_000_000
        assert result["id"] == self.sequence and "error" not in result, result
        return result["result"], elapsed

    def close(self):
        self.selector.close()
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
            raise
        assert self.process.returncode == 0, self.process.stderr.read()
        self.process.stdout.close()
        self.process.stderr.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", required=True, type=Path)
    parser.add_argument("--build-kind", choices=["debug", "release"], required=True)
    parser.add_argument("--iterations", type=int, default=1000)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if os.name != "posix" or not 100 <= args.iterations <= 10000:
        parser.error("Requires POSIX and 100..10000 iterations")
    binary = args.backend.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="futureox-metadata-benchmark-") as temporary:
        directory = Path(temporary).resolve()
        backend = Backend(binary, directory)
        try:
            _, startup = backend.call("automation.status", {})
            backend.call("automation.config.set", {"maxAuditEntries": 1000})
            appends = []
            for i in range(args.iterations + 50):
                _, elapsed = backend.call("automation.audit.append", {
                    "event": "edit", "source": "user" if i % 2 else "automation",
                    "summary": "Adjust layout: 3 nodes", "documentId": "synthetic-document",
                    "session": 1, "revision": i, "status": "succeeded"})
                if i >= 50:
                    appends.append(elapsed)
            reads = []
            for _ in range(100):
                result, elapsed = backend.call("automation.audit.list", {
                    "limit": 100, "documentId": "synthetic-document", "source": "user"})
                assert len(result["entries"]) == min(100, (args.iterations + 50) // 2)
                reads.append(elapsed)
            backend.call("automation.task.put", {"id": "synthetic-task", "method": "node.update", "status": "completed"})
            before, _ = backend.call("automation.status", {})
            assert before["auditCount"] == min(1000, args.iterations + 50)
            assert before["authorizationPersisted"] is False
        finally:
            backend.close()
        backend = Backend(binary, directory)
        try:
            after, restart = backend.call("automation.status", {})
            assert after == before and after["taskCount"] == 1
        finally:
            backend.close()
        report = {"platform": platform.system(), "architecture": platform.machine(), "buildKind": args.build_kind,
                  "scope": "real stdio + SQLite synthetic metadata only; no rendering, GPU or GUI",
                  "initialStartupMs": round(startup, 3), "restartMs": round(restart, 3),
                  "auditAppend": stats(appends), "filtered100RowRead": stats(reads),
                  "retainedAuditRows": after["auditCount"], "workspaceBytesAfterClose": (directory / "workspace.sqlite3").stat().st_size,
                  "peakChildRssBytes": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * (1 if platform.system() == "Darwin" else 1024),
                  "restartVerified": True, "authorizationPersisted": False,
                  "note": "Single local run, not a production SLA; 50 append warmups excluded. RSS is whole child process, not retained JSON budget."}
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(encoded)
    print(encoded, end="")


if __name__ == "__main__":
    main()
