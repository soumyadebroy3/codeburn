import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { CodeBurnIndicator } from './indicator.js';

export default class CodeBurnExtension extends Extension {
  _indicator = null;

  enable() {
    this._indicator = new CodeBurnIndicator(this);
  }

  disable() {
    this._indicator?.destroy();
    this._indicator = null;
  }
}
