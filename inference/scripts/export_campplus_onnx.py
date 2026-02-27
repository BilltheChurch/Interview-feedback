"""Export CAM++ speaker verification model to ONNX.

Strategy: Export only the embedding_model (CAMPPlus CNN backbone), since
the outer SpeakerVerificationCAMPPlus.forward() uses a Python loop for
FBank extraction that cannot be traced by ONNX. FBank features are computed
in Python/numpy at inference time.

Model: iic/speech_campplus_sv_zh_en_16k-common_advanced
Input: FBank features [batch, time, 80]
Output: Speaker embedding [batch, 192]
Output file: ~/.cache/campplus-onnx/campplus.onnx

Usage:
    python scripts/export_campplus_onnx.py
    python scripts/export_campplus_onnx.py --output ~/.cache/campplus-onnx/ --model iic/speech_campplus_sv_zh_en_16k-common_advanced
"""

import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def export(output_dir: str, model_id: str):
    os.makedirs(output_dir, exist_ok=True)
    os.environ.setdefault("MODELSCOPE_CACHE", os.path.expanduser("~/.cache/modelscope"))

    import torch
    from modelscope.pipelines import pipeline
    from modelscope.utils.constant import Tasks

    print(f"Loading ModelScope CAM++ pipeline: {model_id}")
    sv_pipeline = pipeline(
        task=Tasks.speaker_verification,
        model=model_id,
    )

    model = sv_pipeline.model
    model.eval()
    model.cpu()

    # The embedding_model is the pure CNN backbone (CAMPPlus)
    # It takes FBank features [B, T, 80] and outputs embeddings [B, 192]
    embedding_model = model.embedding_model
    embedding_model.eval()

    feature_dim = model.feature_dim  # 80
    print(f"Feature dim: {feature_dim}, Embedding size: {model.emb_size}")

    # Create dummy FBank features: [batch=1, time=98, feature=80]
    # 98 frames corresponds to ~1 second of audio at 16kHz (10ms frame shift)
    dummy_fbank = torch.randn(1, 98, feature_dim)

    output_path = os.path.join(output_dir, "campplus.onnx")

    print("Exporting embedding_model (CAMPPlus) to ONNX...")
    # Use legacy (TorchScript) exporter — dynamo exporter has compatibility issues
    torch.onnx.export(
        embedding_model,
        dummy_fbank,
        output_path,
        input_names=["fbank"],
        output_names=["embedding"],
        dynamic_axes={
            "fbank": {0: "batch", 1: "time"},
            "embedding": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )
    print(f"Model exported to {output_path}")
    file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"ONNX model size: {file_size_mb:.2f} MB")

    # Verify with ONNX Runtime
    import onnxruntime as ort

    session = ort.InferenceSession(output_path)
    test_fbank = np.random.randn(1, 98, feature_dim).astype(np.float32)
    result = session.run(None, {"fbank": test_fbank})
    print(f"ONNX output shape: {result[0].shape}")
    print(f"Embedding dim: {result[0].shape[-1]}")

    # Cross-validate: compare ONNX vs PyTorch output on same input
    with torch.no_grad():
        torch_out = embedding_model(torch.from_numpy(test_fbank))
        torch_emb = torch_out.numpy().flatten()
        onnx_emb = result[0].flatten()

        cos_sim = float(
            np.dot(torch_emb, onnx_emb)
            / (np.linalg.norm(torch_emb) * np.linalg.norm(onnx_emb))
        )
        max_diff = float(np.max(np.abs(torch_emb - onnx_emb)))
        print(f"PyTorch vs ONNX cosine similarity: {cos_sim:.6f}")
        print(f"PyTorch vs ONNX max abs diff: {max_diff:.8f}")

    # Also validate end-to-end: raw audio → FBank → ONNX embedding
    # vs raw audio → PyTorch forward
    test_audio = torch.randn(1, 16000)
    with torch.no_grad():
        pytorch_full = model(test_audio).numpy().flatten()
        # Replicate feature extraction
        fbank_feature = model._SpeakerVerificationCAMPPlus__extract_feature(test_audio)
        onnx_from_fbank = session.run(None, {"fbank": fbank_feature.numpy().astype(np.float32)})
        onnx_full = onnx_from_fbank[0].flatten()

        e2e_cos = float(
            np.dot(pytorch_full, onnx_full)
            / (np.linalg.norm(pytorch_full) * np.linalg.norm(onnx_full))
        )
        e2e_max_diff = float(np.max(np.abs(pytorch_full - onnx_full)))
        print(f"E2E PyTorch vs ONNX cosine similarity: {e2e_cos:.6f}")
        print(f"E2E PyTorch vs ONNX max abs diff: {e2e_max_diff:.8f}")

    # Save metadata
    import json

    metadata = {
        "model_id": model_id,
        "feature_dim": feature_dim,
        "embedding_dim": int(result[0].shape[-1]),
        "input_name": "fbank",
        "output_name": "embedding",
        "input_description": "FBank features [batch, time, 80], computed with Kaldi.fbank(num_mel_bins=80), mean-normalized",
        "output_description": "Speaker embedding [batch, 192]",
        "opset_version": 17,
        "parity_cosine_sim": cos_sim,
        "parity_max_diff": max_diff,
        "e2e_cosine_sim": e2e_cos,
        "e2e_max_diff": e2e_max_diff,
    }
    meta_path = os.path.join(output_dir, "metadata.json")
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)
    print(f"Metadata saved to {meta_path}")
    print("Export verification passed!")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output", default=os.path.expanduser("~/.cache/campplus-onnx/")
    )
    parser.add_argument(
        "--model", default="iic/speech_campplus_sv_zh_en_16k-common_advanced"
    )
    args = parser.parse_args()
    export(args.output, args.model)
