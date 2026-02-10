#!/usr/bin/env python3
"""Scan pod logs across the cluster for connection errors.

Looks for common networking failure patterns: timeouts, connection refused,
DNS failures, etc. Useful for finding misconfigurations like wrong ports
or broken service references after deploying a stack.

Usage:
    python3 scripts/audit-pod-connectivity.py [--namespace monitoring] [--since 1h] [--tail 500]
"""

import argparse
import json
import re
import subprocess
import sys
from collections import defaultdict


ERROR_PATTERNS = [
    re.compile(r"dial tcp [^:]+:\d+:.*(?:i/o timeout|connection refused|operation was canceled)", re.IGNORECASE),
    re.compile(r"connection error.*dial tcp", re.IGNORECASE),
    re.compile(r"(?:NXDOMAIN|no such host)", re.IGNORECASE),
    re.compile(r"connect(?:ion)? (?:timed out|refused)", re.IGNORECASE),
    re.compile(r"upstream connect error|503 Service Unavailable", re.IGNORECASE),
    re.compile(r"failed to connect to", re.IGNORECASE),
]


def get_pods(namespace=None):
    cmd = ["kubectl", "get", "pods", "-o", "json"]
    if namespace:
        cmd += ["-n", namespace]
    else:
        cmd += ["--all-namespaces"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ERROR: kubectl get pods failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return json.loads(result.stdout)["items"]


def get_logs(pod_name, namespace, container, since, tail):
    cmd = [
        "kubectl", "logs", pod_name,
        "-n", namespace,
        "-c", container,
        f"--since={since}",
        f"--tail={tail}",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    return result.stdout


def scan_logs(log_text):
    hits = []
    for line in log_text.splitlines():
        for pattern in ERROR_PATTERNS:
            if pattern.search(line):
                hits.append(line.strip())
                break
    return hits


def extract_endpoints(hits):
    """Pull out the specific host:port pairs that are failing."""
    endpoints = defaultdict(int)
    ep_re = re.compile(r"dial tcp ([^\s:]+:\d+)")
    host_re = re.compile(r'(?:connect to|connecting to|Addr:\s*\\?"?)([a-zA-Z0-9._-]+:\d+)')
    for line in hits:
        for regex in [ep_re, host_re]:
            m = regex.search(line)
            if m:
                endpoints[m.group(1)] += 1
                break
    return endpoints


def main():
    parser = argparse.ArgumentParser(description="Audit pod logs for connectivity errors")
    parser.add_argument("--namespace", "-n", help="Namespace to scan (default: all)")
    parser.add_argument("--since", default="1h", help="Log age to scan (default: 1h)")
    parser.add_argument("--tail", type=int, default=500, help="Lines per container (default: 500)")
    args = parser.parse_args()

    pods = get_pods(args.namespace)
    print(f"Scanning {len(pods)} pods (since={args.since}, tail={args.tail})...\n")

    findings = {}
    all_endpoints = defaultdict(int)

    for pod in pods:
        pod_name = pod["metadata"]["name"]
        ns = pod["metadata"]["namespace"]
        containers = [c["name"] for c in pod.get("spec", {}).get("containers", [])]

        for container in containers:
            try:
                logs = get_logs(pod_name, ns, container, args.since, args.tail)
            except subprocess.TimeoutExpired:
                print(f"  WARN: timeout reading logs from {ns}/{pod_name}/{container}", file=sys.stderr)
                continue

            hits = scan_logs(logs)
            if hits:
                key = f"{ns}/{pod_name}/{container}"
                findings[key] = hits
                for ep, count in extract_endpoints(hits).items():
                    all_endpoints[ep] += count

    if not findings:
        print("No connectivity errors found.")
        return

    # Summary: which endpoints are failing and how often
    print("=" * 70)
    print("FAILING ENDPOINTS (aggregated)")
    print("=" * 70)
    for ep, count in sorted(all_endpoints.items(), key=lambda x: -x[1]):
        print(f"  {ep:45s} {count:>5} hits")

    # Per-pod detail
    print(f"\n{'=' * 70}")
    print(f"AFFECTED PODS ({len(findings)} containers)")
    print("=" * 70)
    for key, hits in sorted(findings.items()):
        # Deduplicate similar lines, show counts
        line_counts = defaultdict(int)
        for h in hits:
            line_counts[h] += 1
        print(f"\n  {key}:")
        for line, count in sorted(line_counts.items(), key=lambda x: -x[1])[:5]:
            prefix = f"    [{count}x] " if count > 1 else "    "
            # Truncate long lines
            if len(line) > 120:
                line = line[:117] + "..."
            print(f"{prefix}{line}")
        if len(line_counts) > 5:
            print(f"    ... and {len(line_counts) - 5} more unique error lines")


if __name__ == "__main__":
    main()
