import numpy as np

from app.schemas import ClusterState
from app.services.clustering import OnlineClusterer


def test_clusterer_creates_first_cluster() -> None:
    clusterer = OnlineClusterer(match_threshold=0.5)
    clusters: list[ClusterState] = []
    emb = np.array([0.1, 0.2, 0.9], dtype=np.float32)

    cluster_id, score = clusterer.assign(embedding=emb, clusters=clusters)

    assert cluster_id == "c1"
    assert score == 1.0
    assert len(clusters) == 1


def test_clusterer_updates_existing_cluster() -> None:
    clusterer = OnlineClusterer(match_threshold=0.5)
    clusters = [
        ClusterState(cluster_id="c1", centroid=[0.0, 0.0, 1.0], sample_count=1),
    ]
    emb = np.array([0.0, 0.1, 0.99], dtype=np.float32)

    cluster_id, score = clusterer.assign(embedding=emb, clusters=clusters)

    assert cluster_id == "c1"
    assert score > 0.9
    assert clusters[0].sample_count == 2
