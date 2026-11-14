import { App, setTooltip } from 'obsidian';
import type { PopupDomRenderer, PopupDomRendererRequest } from "places-shared/map";
import { resolveLocalFile, type LocalFile } from "places-shared/obsidian/utils";
import { ImageLightboxModal, showImageFileMenu } from './ImageLightboxModal';
import { formatPopupFieldValue, toTitleCaseFrontmatterKey } from "places-shared/map";
import { parsePopupRendererOptions } from "places-shared/settings";

export const IMAGE_POPUP_RENDERER_ID = 'image.preview';

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'apng', 'gif', 'webp', 'avif', 'heic', 'heif', 'hif', 'tif', 'tiff', 'jxl', 'bmp', 'ico', 'svg',
  'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'sr2', 'orf', 'rw2', 'raf', 'pef', 'srw', '3fr', 'iiq', 'erf', 'rwl', 'dcr', 'kdc', 'mos',
]);

export function createImagePopupRenderer(app: App): PopupDomRenderer {
  return {
    id: IMAGE_POPUP_RENDERER_ID,
    description: 'Image preview with capture time, camera, and exposure',
    kind: 'dom',
    render: request => { renderImagePopup(app, request); },
  };
}

export function renderImagePopup(app: App, request: PopupDomRendererRequest): void {
  const { context } = request;
  const image = resolveImageTarget(app, context, request.markdownSourcePath);

  if (!image) {
    throw new Error(`${IMAGE_POPUP_RENDERER_ID} requires an image_path or path column naming an image file.`);
  }

  const description = textValue(context.description);
  const root = request.container.createDiv({ cls: 'places-image-popup' });
  const frame = root.createDiv({ cls: 'places-image-popup-frame' });
  const aspect = aspectRatio(context);

  if (aspect) frame.style.setProperty('--places-image-popup-aspect', aspect);

  const element = frame.createEl('img', {
    cls: 'places-image-popup-image',
    attr: {
      src: image.url,
      alt: image.name,
      loading: 'lazy',
      decoding: 'async',
    },
  });

  element.addEventListener('error', () => {
    frame.empty();
    const unavailable = frame.createDiv({ cls: 'places-image-popup-unavailable', text: `No ${image.extension.toUpperCase()} preview` });

    unavailable.addEventListener('contextmenu', event => {
      event.preventDefault();
      showImageFileMenu(app, image, event);
    });
  }, { once: true });

  const openFullScreen = () => { new ImageLightboxModal(app, image, description).open(); };

  setTooltip(element, 'Open full screen');
  element.addEventListener('click', openFullScreen);
  element.addEventListener('contextmenu', event => {
    event.preventDefault();
    showImageFileMenu(app, image, event, openFullScreen);
  });

  const fields = parsePopupRendererOptions(request.options, `${IMAGE_POPUP_RENDERER_ID}.options`).fields as readonly string[] | undefined;

  if (fields === undefined) {
    if (description) root.createDiv({ cls: 'places-image-popup-description', text: description });
    appendMeta(root, capturedText(context));
    appendMeta(root, cameraText(context));
    appendMeta(root, exposureText(context));
  } else {
    for (const field of fields) {
      if (field === 'description') {
        if (description) root.createDiv({ cls: 'places-image-popup-description', text: description });
      } else appendMeta(root, imageFieldText(context, field));
    }
  }
}

function imageFieldText(context: Readonly<Record<string, unknown>>, field: string): string | undefined {
  if (field === 'captured' || field === 'captured_local') return capturedText(context);
  if (['camera_model', 'camera_make', 'lens_model'].includes(field)) return textValue(context[field]);

  if (['f_number', 'exposure_time', 'exposure_time_text', 'iso', 'focal_length', 'focal_length_35mm'].includes(field)) {
    return exposureText({ [field]: context[field] });
  }

  if (context[field] == null) return undefined;
  const value = formatPopupFieldValue(context[field]);

  return value.trim() ? `${toTitleCaseFrontmatterKey(field)}: ${value}` : undefined;
}

function resolveImageTarget(app: App, context: Readonly<Record<string, unknown>>, sourcePath: string | undefined): LocalFile | null {
  const value = textValue(context.image_path) ?? textValue(context.path);

  if (!value) return null;
  const image = resolveLocalFile(app, value, sourcePath);

  return image && IMAGE_EXTENSIONS.has(image.extension) ? image : null;
}

function aspectRatio(context: Readonly<Record<string, unknown>>): string | null {
  const width = finiteNumber(context.oriented_width) ?? finiteNumber(context.width);
  const height = finiteNumber(context.oriented_height) ?? finiteNumber(context.height);

  return width && height && width > 0 && height > 0 ? `${width} / ${height}` : null;
}

function capturedText(context: Readonly<Record<string, unknown>>): string | undefined {
  const local = textValue(context.captured_local);
  const date = local ? new Date(local.replace(' ', 'T')) : new Date(finiteNumber(context.captured) ?? NaN);

  if (Number.isNaN(date.getTime())) return local;

  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function cameraText(context: Readonly<Record<string, unknown>>): string | undefined {
  const camera = textValue(context.camera_model) ?? textValue(context.camera_make);
  const lens = textValue(context.lens_model);

  return joinParts([camera, lens === camera ? undefined : lens]);
}

function exposureText(context: Readonly<Record<string, unknown>>): string | undefined {
  const aperture = finiteNumber(context.f_number);
  const exposure = textValue(context.exposure_time_text) ?? formatSeconds(finiteNumber(context.exposure_time));
  const iso = finiteNumber(context.iso);
  const focalLength = finiteNumber(context.focal_length) ?? finiteNumber(context.focal_length_35mm);

  return joinParts([
    aperture === undefined ? undefined : `f/${trimNumber(aperture, 1)}`,
    exposure === undefined ? undefined : `${exposure} s`,
    iso === undefined ? undefined : `ISO ${Math.round(iso)}`,
    focalLength === undefined ? undefined : `${trimNumber(focalLength, 1)} mm`,
  ]);
}

function appendMeta(container: HTMLElement, text: string | undefined): void {
  if (!text) return;
  container.createDiv({ cls: 'places-image-popup-meta', text });
}

function joinParts(parts: readonly (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part));

  return present.length > 0 ? present.join(' · ') : undefined;
}

function formatSeconds(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;

  return value >= 1 ? trimNumber(value, 1) : `1/${Math.round(1 / value)}`;
}

function trimNumber(value: number, precision: number): string {
  return value.toFixed(precision).replace(/\.?0+$/, '');
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;

  return Number.isFinite(parsed) ? parsed : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
