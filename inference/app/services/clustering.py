from __future__ import annotations

import re

import numpy as np

from app.schemas import ClusterState


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    a_norm = np.linalg.norm(a)
    b_norm = np.linalg.norm(b)
    if a_norm == 0.0 or b_norm == 0.0:
        return -1.0
    return float(np.dot(a, b) / (a_norm * b_norm))


def _next_cluster_id(clusters: list[ClusterState]) -> str:
    max_id = 0
    for cluster in clusters:
        match = re.match(r"^c(\d+)$", cluster.cluster_id)
        if not match:
            continue
        max_id = max(max_id, int(match.group(1)))
    return f"c{max_id + 1}"


class OnlineClusterer:
    def __init__(self, match_threshold: float) -> None:
        self._match_threshold = match_threshold

    def assign(self, embedding: np.ndarray, clusters: list[ClusterState]) -> tuple[str, float]:
        if not clusters:
            new_id = _next_cluster_id(clusters)
            clusters.append(
                ClusterState(
                    cluster_id=new_id,
                    centroid=embedding.astype(np.float32).tolist(),
                    sample_count=1,
                )
            )
            return new_id, 1.0

        best_idx = -1
        best_score = -1.0
        for idx, cluster in enumerate(clusters):
            centroid = np.asarray(cluster.centroid, dtype=np.float32)
            score = cosine_similarity(embedding, centroid)
            if score > best_score:
                best_idx = idx
                best_score = score

        if best_idx >= 0 and best_score >= self._match_threshold:
            target = clusters[best_idx]
            old_centroid = np.asarray(target.centroid, dtype=np.float32)
            n = float(target.sample_count)
            updated = ((old_centroid * n) + embedding) / (n + 1.0)
            target.centroid = updated.astype(np.float32).tolist()
            target.sample_count += 1
            return target.cluster_id, best_score

        new_id = _next_cluster_id(clusters)
        clusters.append(
            ClusterState(
                cluster_id=new_id,
                centroid=embedding.astype(np.float32).tolist(),
                sample_count=1,
            )
        )
        return new_id, best_score
