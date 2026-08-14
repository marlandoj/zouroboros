---
name: fal-ai-media
description: Generate and edit images and videos via the fal.ai API using models including nano-banana-2, gpt-image-2, kling-v3-std, and veo3.1-fast, routing through the user's FAL_KEY to minimize Zo credit usage.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
---
# fal-ai-media

Image and video generation skill using the fal.ai API with the user's own FAL_KEY.

## Usage

```bash
bun /home/workspace/Skills/fal-ai-media/scripts/fal-media.ts <command> [options]
```

## Commands

| Command | Description |
| --- | --- |
| `generate` | Text-to-image generation |
| `edit` | Image editing / transformation |
| `video` | Image-to-video generation |
| `t2v` | Text-to-video generation |
| `models` | List available models |

## Model Selection

- **Text in image** (titles, thumbnails, labels): `--model gpt-image-2`
- **Standard generation**: `--model nano-banana-2` (default)
- **High-quality/campaign**: `--model nano-banana-pro`
- **Video from image**: `--model kling-v3-std` (default)
- **Text-to-video**: `--model veo3.1-fast` (default)

## Examples

```bash
# Generate an image
bun scripts/fal-media.ts generate --prompt "A serene mountain landscape" --output /home/workspace/Images/mountain.png

# Edit an existing image
bun scripts/fal-media.ts edit --prompt "Change background to sunset" --image /home/workspace/Images/photo.png --output /home/workspace/Images/edited.png

# Generate video from image
bun scripts/fal-media.ts video --prompt "Camera slowly pans right" --image /home/workspace/Images/scene.png --output /home/workspace/Images/scene.mp4
```

## Notes

- Requires `FAL_KEY` in Zo Secrets (Settings &gt; Advanced)
- GPT Image 2 caveats: no PNG transparency, max aspect 3:1, endpoint is `fal-ai/gpt-image-2`
- `edit` supports `--model gpt-image-2 | nano-banana-2 | nano-banana-pro` (verified `image_urls`-array edit endpoints). `flux-kontext` is generate-only for now — its real fal edit endpoint (`fal-ai/flux-pro/kontext`, singular `image_url`) has a different request shape and is not wired into `edit` yet.
- `video`/image-to-video is not implemented in the script yet (only `t2v` text-to-video exists) — do not reference `video` as a working command until it's added.
- Always save outputs to `/home/workspace/Images/` with descriptive filenames