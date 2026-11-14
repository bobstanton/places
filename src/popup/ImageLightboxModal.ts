import { App, Menu, Modal } from 'obsidian';
import { canOpenDevicePaths, canRevealDevicePaths, openInDefaultApp, showInSystemExplorer, type LocalFile } from "places-shared/obsidian/utils";

export const IMAGE_MENU_SOURCE = 'places-image-popup';

export function showImageFileMenu(app: App, image: LocalFile, event: MouseEvent, openFullScreen?: () => void): void {
  const menu = new Menu();

  if (openFullScreen) {
    menu.addItem(item => item.setSection('open').setTitle('Open full screen').setIcon('lucide-expand').onClick(openFullScreen));
  }

  if (image.file) {
    app.workspace.trigger('file-menu', menu, image.file, IMAGE_MENU_SOURCE);
    menu.showAtMouseEvent(event);

    return;
  }

  const devicePath = image.devicePath;

  if (devicePath && canOpenDevicePaths(app)) {
    menu.addItem(item => item.setSection('system').setTitle('Open in default app').setIcon('lucide-external-link')
      .onClick(() => { void openInDefaultApp(app, devicePath); }));
  }

  if (devicePath && canRevealDevicePaths()) {
    menu.addItem(item => item.setSection('system').setTitle('Show in system explorer').setIcon('lucide-folder-open')
      .onClick(() => { showInSystemExplorer(devicePath); }));
  }

  if (devicePath) {
    menu.addItem(item => item.setSection('info').setTitle('Copy path').setIcon('lucide-copy')
      .onClick(() => { void navigator.clipboard.writeText(devicePath); }));
  }

  menu.showAtMouseEvent(event);
}

export class ImageLightboxModal extends Modal {
  constructor(app: App, private readonly image: LocalFile, private readonly caption?: string) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('places-image-lightbox');
    this.contentEl.addClass('places-image-lightbox-content');

    const element = this.contentEl.createEl('img', {
      cls: 'places-image-lightbox-image',
      attr: { src: this.image.url, alt: this.image.name },
    });

    element.addEventListener('contextmenu', event => {
      event.preventDefault();
      showImageFileMenu(this.app, this.image, event);
    });

    const footer = this.contentEl.createDiv({ cls: 'places-image-lightbox-footer' });

    footer.createDiv({ cls: 'places-image-lightbox-caption', text: this.caption ?? this.image.name });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
