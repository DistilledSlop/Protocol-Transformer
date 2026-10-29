"""Build and cache the training-only row grammar used by inference."""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from pathlib import Path

from protocol_ai import data
from protocol_ai.generate import Grammar
from protocol_ai.fields import category

# Bump this when tokenization, category mapping, or grammar learning changes.
CACHE_VERSION = 1


def _learn_session(task):
    dataset, session, vocab_tokens = task
    vocab = data.Vocab.from_tokens(vocab_tokens)
    name, first, last = session
    ticks = data.load_ticks(Path(dataset) / f"{name}.ticks.jsonl")
    stream = data.build_stream(ticks, first, last, vocab)
    return Grammar.learn(vocab, {name: stream})


def _key(dataset, sessions, vocab):
    sources = []
    for name, first, last in sessions:
        stat = (dataset / f"{name}.ticks.jsonl").stat()
        sources.append([name, first, last, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns])
    payload = [CACHE_VERSION, vocab.tokens, sources]
    return hashlib.sha256(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def default_jobs():
    try:
        cores = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        cores = os.cpu_count() or 1
    try:
        available = os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
        try:
            limit = Path("/sys/fs/cgroup/memory.max").read_text().strip()
            if limit != "max":
                used = int(Path("/sys/fs/cgroup/memory.current").read_text())
                available = min(available, max(0, int(limit) - used))
        except (OSError, ValueError):
            pass
        memory_jobs = max(1, available // (1024 ** 3))
    except (ValueError, OSError):
        memory_jobs = 1
    return min(cores, memory_jobs, 16)


def learn_cached(dataset, vocab, excluded, jobs=None):
    jobs = default_jobs() if jobs is None else jobs
    if jobs < 1:
        raise ValueError("grammar jobs must be at least 1")
    dataset = Path(dataset)
    manifest = json.loads((dataset / "manifest.json").read_text())
    excluded = set(excluded)
    sessions = [(s["name"], int(s["firstTick"]), int(s["lastTick"]))
                for s in manifest["sessions"] if s["name"] not in excluded]
    key = _key(dataset, sessions, vocab)
    cache_dir = dataset / "grammar-cache"
    cache = cache_dir / f"{key}.json"
    try:
        obj = json.loads(cache.read_text())
        if isinstance(obj, dict) and obj.get("key") == key and isinstance(obj.get("pairs"), list):
            pairs = {tuple(p) for p in obj["pairs"] if isinstance(p, list) and len(p) == 2 and all(isinstance(x, str) for x in p)}
            cats = {category(t) for t in vocab.tokens}
            if len(pairs) == len(obj["pairs"]) and all(a in cats and b in cats for a, b in pairs):
                print(f"Loaded grammar cache ({len(sessions)} training sessions)", file=sys.stderr, flush=True)
                return pairs
    except (OSError, ValueError, TypeError):
        pass
    jobs = min(jobs, max(1, len(sessions)))
    print(f"Learning grammar from {len(sessions)} training sessions using {jobs} CPU worker(s)", file=sys.stderr, flush=True)
    tasks = ((str(dataset), session, vocab.tokens) for session in sessions)
    pairs = set()
    if jobs == 1:
        results = map(_learn_session, tasks)
        for i, result in enumerate(results, 1):
            pairs.update(result)
            if i % 50 == 0 or i == len(sessions):
                print(f"Grammar: {i}/{len(sessions)} sessions", file=sys.stderr, flush=True)
    else:
        # Spawn avoids forking after CUDA has been initialized in the parent.
        import multiprocessing
        pool = ProcessPoolExecutor(max_workers=jobs, mp_context=multiprocessing.get_context("spawn"))
        pending = set()
        try:
            task_iter = iter(tasks)
            for task in task_iter:
                pending.add(pool.submit(_learn_session, task))
                if len(pending) >= jobs * 2:
                    break
            i = 0
            while pending:
                done, pending = wait(pending, return_when=FIRST_COMPLETED)
                for future in done:
                    pairs.update(future.result())
                    i += 1
                    if i % 50 == 0 or i == len(sessions):
                        print(f"Grammar: {i}/{len(sessions)} sessions", file=sys.stderr, flush=True)
                for _ in done:
                    task = next(task_iter, None)
                    if task is not None:
                        pending.add(pool.submit(_learn_session, task))
        except BaseException:
            for future in pending:
                future.cancel()
            pool.shutdown(wait=True, cancel_futures=True)
            raise
        else:
            pool.shutdown(wait=True)
    # Never save a cache if sources changed during the scan.
    if _key(dataset, sessions, vocab) == key:
        try:
            cache_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile("w", dir=cache_dir, delete=False) as f:
                temp = Path(f.name)
                try:
                    json.dump({"key": key, "pairs": sorted(pairs)}, f)
                except BaseException:
                    temp.unlink(missing_ok=True)
                    raise
            try:
                os.replace(temp, cache)
            finally:
                temp.unlink(missing_ok=True)
        except OSError as exc:
            print(f"Could not save grammar cache: {exc}", file=sys.stderr, flush=True)
    else:
        print("Grammar sources changed during scan; cache not saved", file=sys.stderr, flush=True)
    return pairs
