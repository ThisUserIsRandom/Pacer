# models/

Drop a **GGUF** model here for Pacer's built-in, in-process provider.

```
models/model.gguf     ← the file Pacer looks for
```

Pacer never scans for models: the built-in provider reads exactly
`models/model.gguf` (or `LOCAL_MODEL_PATH` if you set that env var).

## Getting a model

```bash
npm run model:download                      # Qwen3-0.6B Q8_0, ~640 MB
npm run model:download -- --url <gguf-url>  # any GGUF
npm run model:link -- /path/to/model.gguf   # reuse one you already have
```

Or just copy your own file here:

```bash
cp /path/to/your-model.gguf models/model.gguf
```

## Which models work

Small instruct models are the sweet spot — fast on CPU, small RAM footprint.
Tested with **Qwen3-0.6B** (Q8: ~640 MB, ~1.3 s to load, ~14 words/s on a
12-core CPU). Anything llama.cpp can read should work; 1–4B models are the
practical upper end for CPU-only use.

`.gguf` files are git-ignored, so this folder stays empty in the repo.
