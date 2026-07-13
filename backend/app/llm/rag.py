"""Lightweight Retrieval-Augmented Generation (RAG) knowledge store.

Indexes project documentation and fixture metadata into an in-memory vector
store on startup.  Provides ``retrieve(query, k)`` that returns the top-k
most relevant text chunks for injection into the LLM chat prompt.

Design decisions:
  * Zero new dependencies — uses numpy (already installed) for TF-IDF
    cosine similarity rather than pulling in ChromaDB / FAISS / sentence-
    transformers.  This keeps the install footprint tiny for a hackathon
    while still being genuine RAG: there is a retrieval step, a ranking
    step, and the retrieved text is injected into the generative prompt.
  * When a Gemini API key is available *and* google-generativeai ≥ 0.8
    is installed, embeds with ``gemini-embedding-001`` for much better
    semantic matching.  Falls back to the TF-IDF path transparently.
  * Thread-safe: the index is built once at startup; retrieval is a
    pure numpy dot-product — no locks needed.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
import structlog

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Module state — populated by ``build_index()``
# ---------------------------------------------------------------------------
_chunks: list[dict[str, str]] = []      # {"text": ..., "source": ..., "section": ...}
_tfidf_matrix: np.ndarray | None = None  # shape (n_chunks, vocab_size)
_vocab: list[str] = []                   # ordered vocabulary list
_idf: np.ndarray | None = None           # inverse doc frequency vector
_gemini_embeddings: np.ndarray | None = None  # (n_chunks, embed_dim) when available

# Paths relative to the backend root.
_BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent  # backend/
_DOCS_ROOT = _BACKEND_ROOT.parent / "docs"
_FIXTURES_DIR = _BACKEND_ROOT / "data" / "fixtures"
_PROJECT_ROOT = _BACKEND_ROOT.parent


# ---------------------------------------------------------------------------
# Chunking helpers
# ---------------------------------------------------------------------------

def _chunk_markdown(text: str, source: str, max_chars: int = 500) -> list[dict[str, str]]:
    """Split a markdown document into chunks by heading sections.

    Each chunk is a self-contained paragraph or section small enough to fit
    within ``max_chars``.  The section heading is prepended so the chunk
    carries its own context.
    """
    chunks: list[dict[str, str]] = []
    current_section = "Introduction"
    current_block: list[str] = []
    current_len = 0

    for line in text.splitlines():
        heading_match = re.match(r"^(#{1,4})\s+(.+)", line)
        if heading_match:
            # Flush current block
            if current_block:
                chunks.append({
                    "text": "\n".join(current_block).strip(),
                    "source": source,
                    "section": current_section,
                })
                current_block = []
                current_len = 0
            current_section = heading_match.group(2).strip()
            continue

        if current_len + len(line) > max_chars and current_block:
            chunks.append({
                "text": "\n".join(current_block).strip(),
                "source": source,
                "section": current_section,
            })
            current_block = []
            current_len = 0

        current_block.append(line)
        current_len += len(line) + 1

    if current_block:
        chunks.append({
            "text": "\n".join(current_block).strip(),
            "source": source,
            "section": current_section,
        })

    return [c for c in chunks if len(c["text"].strip()) > 20]


def _chunk_json(data: Any, source: str, max_chars: int = 500) -> list[dict[str, str]]:
    """Convert a JSON fixture into text chunks.

    For lists of objects: each object becomes a chunk (serialised).
    For dicts: each top-level key becomes a chunk.
    """
    chunks: list[dict[str, str]] = []

    if isinstance(data, list):
        for i, item in enumerate(data):
            text = json.dumps(item, indent=2, default=str)
            if len(text) > max_chars:
                text = text[:max_chars] + " ..."
            chunks.append({
                "text": text,
                "source": source,
                "section": f"item_{i}",
            })
    elif isinstance(data, dict):
        for key, value in data.items():
            text = f"{key}: {json.dumps(value, indent=2, default=str)}"
            if len(text) > max_chars:
                text = text[:max_chars] + " ..."
            chunks.append({
                "text": text,
                "source": source,
                "section": str(key),
            })
    else:
        chunks.append({
            "text": json.dumps(data, indent=2, default=str)[:max_chars],
            "source": source,
            "section": "root",
        })

    return [c for c in chunks if len(c["text"].strip()) > 20]


# ---------------------------------------------------------------------------
# TF-IDF vectoriser (zero extra deps)
# ---------------------------------------------------------------------------

_STOP_WORDS = frozenset(
    "the a an is are was were be been being have has had do does did will would "
    "shall should may might can could of in to for on with at by from as into "
    "through during before after above below up down out off over under again "
    "further then once here there when where why how all each every both few "
    "more most other some such no nor not only own same so than too very and "
    "but if or because until while".split()
)


def _tokenize(text: str) -> list[str]:
    """Simple whitespace + punctuation tokeniser with stop-word removal."""
    tokens = re.findall(r"[a-z0-9_]+(?:\.[a-z0-9]+)*", text.lower())
    return [t for t in tokens if t not in _STOP_WORDS and len(t) > 1]


def _build_tfidf(texts: list[str]) -> tuple[np.ndarray, list[str], np.ndarray]:
    """Build a TF-IDF matrix from a list of document strings.

    Returns (matrix, vocabulary, idf_vector).
    """
    # Build vocabulary
    doc_tokens = [_tokenize(t) for t in texts]
    n_docs = len(doc_tokens)
    vocab_counter: Counter[str] = Counter()
    doc_freq: Counter[str] = Counter()
    for tokens in doc_tokens:
        vocab_counter.update(tokens)
        doc_freq.update(set(tokens))

    # Keep tokens that appear in at least 1 doc and at most 90% of docs
    max_df = max(1, int(n_docs * 0.9))
    vocab = sorted(
        t for t, df in doc_freq.items()
        if df <= max_df and vocab_counter[t] >= 1
    )
    token_to_idx = {t: i for i, t in enumerate(vocab)}

    # Compute TF (log-normalised)
    matrix = np.zeros((n_docs, len(vocab)), dtype=np.float32)
    for doc_i, tokens in enumerate(doc_tokens):
        tf_counter = Counter(tokens)
        for token, count in tf_counter.items():
            idx = token_to_idx.get(token)
            if idx is not None:
                matrix[doc_i, idx] = 1.0 + math.log(count)

    # IDF
    idf = np.log(n_docs / (1 + np.array([doc_freq.get(t, 0) for t in vocab], dtype=np.float32)))

    # TF-IDF
    tfidf = matrix * idf[np.newaxis, :]

    # L2 normalise each row
    norms = np.linalg.norm(tfidf, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    tfidf = tfidf / norms

    return tfidf, vocab, idf


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_index() -> int:
    """Ingest all knowledge sources and build the retrieval index.

    Returns the number of chunks indexed.  Safe to call multiple times;
    subsequent calls rebuild from scratch.
    """
    global _chunks, _tfidf_matrix, _vocab, _idf, _gemini_embeddings

    raw_chunks: list[dict[str, str]] = []

    # 1. Markdown documentation
    md_files = [
        (_DOCS_ROOT / "assumptions.md", "docs/assumptions.md"),
        (_PROJECT_ROOT / "CLAUDE.md", "CLAUDE.md"),
        (_PROJECT_ROOT / "README.md", "README.md"),
    ]
    for path, label in md_files:
        if path.exists():
            try:
                text = path.read_text(encoding="utf-8")
                raw_chunks.extend(_chunk_markdown(text, label))
                log.info("rag.indexed_md", source=label, chunks=len(raw_chunks))
            except Exception as exc:
                log.warning("rag.md_read_failed", source=label, error=str(exc))

    # 2. JSON fixtures (only selected high-value files)
    json_files = [
        "refineries.json",
        "dependency_graph.json",
        "critical_minerals.json",
        "india_imports.json",
        "lng_terminals.json",
        "sanctions.json",
    ]
    for fname in json_files:
        fpath = _FIXTURES_DIR / fname
        if fpath.exists():
            try:
                data = json.loads(fpath.read_text(encoding="utf-8"))
                raw_chunks.extend(_chunk_json(data, f"fixtures/{fname}"))
            except Exception as exc:
                log.warning("rag.json_read_failed", source=fname, error=str(exc))

    if not raw_chunks:
        log.warning("rag.no_chunks_found")
        return 0

    _chunks = raw_chunks
    texts = [c["text"] for c in _chunks]

    # Build TF-IDF index (always available as fallback)
    _tfidf_matrix, _vocab, _idf = _build_tfidf(texts)

    # Attempt Gemini embeddings for better semantic matching
    _gemini_embeddings = None
    try:
        _try_gemini_embeddings(texts)
    except Exception as exc:
        log.info("rag.gemini_embed_skipped", reason=str(exc))

    log.info("rag.index_ready", total_chunks=len(_chunks),
             gemini_embeddings=_gemini_embeddings is not None)
    return len(_chunks)


def _try_gemini_embeddings(texts: list[str]) -> None:
    """Attempt to embed all chunks using Gemini gemini-embedding-001."""
    global _gemini_embeddings

    from app.config import get_settings
    settings = get_settings()
    api_key = getattr(settings, "gemini_api_key", None)
    if not api_key:
        raise RuntimeError("No Gemini API key configured")

    import google.generativeai as genai
    genai.configure(api_key=api_key)

    # Batch embed — Gemini supports up to 100 texts per call
    all_embeddings: list[list[float]] = []
    batch_size = 50
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        # Truncate long chunks to stay within token limits
        batch = [t[:2000] for t in batch]
        result = genai.embed_content(
            model="models/gemini-embedding-001",
            content=batch,
            task_type="retrieval_document",
        )
        all_embeddings.extend(result["embedding"])

    _gemini_embeddings = np.array(all_embeddings, dtype=np.float32)
    # L2 normalise
    norms = np.linalg.norm(_gemini_embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    _gemini_embeddings = _gemini_embeddings / norms
    log.info("rag.gemini_embeddings_ready", dim=_gemini_embeddings.shape[1])


def retrieve(query: str, k: int = 5) -> list[dict[str, str]]:
    """Retrieve the top-k most relevant chunks for a query.

    Returns a list of dicts with keys: text, source, section, score.
    Falls back gracefully when the index is not built.
    """
    if not _chunks:
        return []

    k = min(k, len(_chunks))

    # Try Gemini embeddings first (better semantic match)
    if _gemini_embeddings is not None:
        try:
            scores = _retrieve_gemini(query)
            top_indices = np.argsort(scores)[-k:][::-1]
            return [
                {**_chunks[i], "score": f"{scores[i]:.4f}"}
                for i in top_indices if scores[i] > 0.05
            ]
        except Exception:
            pass  # fall through to TF-IDF

    # TF-IDF fallback
    if _tfidf_matrix is not None and _idf is not None:
        scores = _retrieve_tfidf(query)
        top_indices = np.argsort(scores)[-k:][::-1]
        return [
            {**_chunks[i], "score": f"{scores[i]:.4f}"}
            for i in top_indices if scores[i] > 0.01
        ]

    return []


def _retrieve_tfidf(query: str) -> np.ndarray:
    """Compute cosine similarity between query and all chunks using TF-IDF."""
    assert _tfidf_matrix is not None and _idf is not None

    token_to_idx = {t: i for i, t in enumerate(_vocab)}
    tokens = _tokenize(query)
    tf_counter = Counter(tokens)

    q_vec = np.zeros(len(_vocab), dtype=np.float32)
    for token, count in tf_counter.items():
        idx = token_to_idx.get(token)
        if idx is not None:
            q_vec[idx] = (1.0 + math.log(count)) * _idf[idx]

    # L2 normalise
    norm = np.linalg.norm(q_vec)
    if norm > 0:
        q_vec /= norm

    # Cosine similarity = dot product of L2-normalised vectors
    return _tfidf_matrix @ q_vec


def _retrieve_gemini(query: str) -> np.ndarray:
    """Compute cosine similarity using Gemini embeddings."""
    assert _gemini_embeddings is not None

    from app.config import get_settings
    settings = get_settings()
    import google.generativeai as genai
    genai.configure(api_key=settings.gemini_api_key)

    result = genai.embed_content(
        model="models/gemini-embedding-001",
        content=query[:2000],
        task_type="retrieval_query",
    )
    q_vec = np.array(result["embedding"], dtype=np.float32)
    norm = np.linalg.norm(q_vec)
    if norm > 0:
        q_vec /= norm

    return _gemini_embeddings @ q_vec


def chunk_count() -> int:
    """Return the number of indexed chunks."""
    return len(_chunks)


def is_ready() -> bool:
    """Return True if the index has been built and has at least one chunk."""
    return len(_chunks) > 0


def using_gemini_embeddings() -> bool:
    """Return True if Gemini embeddings are active (vs TF-IDF fallback)."""
    return _gemini_embeddings is not None
