import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { DataClient } from './dataClient.js';

const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: '7 Days' },
  { id: '30days', label: '30 Days' },
  { id: 'month', label: 'Month' },
  { id: 'all', label: 'All' },
];

function formatCost(cost) {
  if (cost == null || isNaN(cost)) return '$?';
  return `$${cost.toFixed(2)}`;
}

function formatPercent(val) {
  if (val == null || isNaN(val)) return '—';
  return `${(val * 100).toFixed(0)}%`;
}

function formatPercentDirect(val) {
  if (val == null || isNaN(val)) return '—';
  return `${val.toFixed(1)}%`;
}

export const CodeBurnIndicator = GObject.registerClass(
class CodeBurnIndicator extends PanelMenu.Button {
  _extension;
  _settings;
  _dataClient;
  _refreshSourceId = 0;
  _panelLabel;
  _panelIcon;
  _currentPeriod = 'today';
  _currentProvider = 'all';
  _lastPayload = null;
  _isStale = false;
  _settingsChangedIds = [];

  _init(extension) {
    super._init(0.5, 'CodeBurn Monitor', false);
    this._extension = extension;
    this._settings = extension.getSettings();
    this._dataClient = new DataClient(this._settings.get_string('codeburn-path'));
    this._currentPeriod = this._settings.get_string('default-period') || 'today';

    this._buildPanelButton();
    this._buildMenu();
    Main.panel.addToStatusArea('codeburn-indicator', this);

    this._connectSettings();
    this._startRefreshLoop();
    this._refresh();
  }

  _buildPanelButton() {
    const box = new St.BoxLayout({ style_class: 'panel-button' });

    this._panelIcon = new St.Icon({
      icon_name: 'codeburn-symbolic',
      style_class: 'system-status-icon',
    });

    this._panelLabel = new St.Label({
      text: '$—',
      y_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: 'codeburn-panel-label',
    });

    box.add_child(this._panelIcon);
    box.add_child(this._panelLabel);
    this._panelLabel.visible = !this._settings.get_boolean('compact-mode');

    this.add_child(box);
  }

  _buildMenu() {
    this.menu.removeAll();

    this._heroItem = this._addMenuItem('Loading...');
    this._heroItem.label.style_class = 'codeburn-hero-label';

    this._statsItem = this._addMenuItem('');

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._periodSection = new PopupMenu.PopupSubMenuMenuItem('Period: Today');
    this.menu.addMenuItem(this._periodSection);
    for (const p of PERIODS) {
      const item = new PopupMenu.PopupMenuItem(p.label);
      item.connect('activate', () => {
        this._currentPeriod = p.id;
        this._periodSection.label.text = `Period: ${p.label}`;
        this._refresh();
      });
      this._periodSection.menu.addMenuItem(item);
    }

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._providerHeader = this._addMenuItem('Providers');
    this._providerHeader.setSensitive(false);
    this._providerItems = [];

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(''));
    this._providerSeparator = this.menu._getMenuItems().at(-1);

    this._activitiesSection = new PopupMenu.PopupSubMenuMenuItem('Top Activities');
    this.menu.addMenuItem(this._activitiesSection);

    this._modelsSection = new PopupMenu.PopupSubMenuMenuItem('Top Models');
    this.menu.addMenuItem(this._modelsSection);

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._cacheItem = this._addMenuItem('Cache Hit: —');
    this._oneShotItem = this._addMenuItem('One-shot Rate: —');

    this._budgetItem = this._addMenuItem('');
    this._budgetItem.visible = false;

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const refreshItem = new PopupMenu.PopupMenuItem('Refresh');
    refreshItem.connect('activate', () => this._refresh());
    this.menu.addMenuItem(refreshItem);

    const reportItem = new PopupMenu.PopupMenuItem('Open Full Report');
    reportItem.connect('activate', () => this._openReport());
    this.menu.addMenuItem(reportItem);

    const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
    prefsItem.connect('activate', () => {
      this._extension.openPreferences();
    });
    this.menu.addMenuItem(prefsItem);
  }

  _addMenuItem(text) {
    const item = new PopupMenu.PopupMenuItem(text);
    item.setSensitive(false);
    this.menu.addMenuItem(item);
    return item;
  }

  _connectSettings() {
    const watch = (key, cb) => {
      const id = this._settings.connect(`changed::${key}`, cb);
      this._settingsChangedIds.push(id);
    };

    watch('refresh-interval', () => this._restartRefreshLoop());
    watch('compact-mode', () => this._rebuildPanelButton());
    watch('codeburn-path', () => {
      this._dataClient.setCodeburnPath(this._settings.get_string('codeburn-path'));
      this._refresh();
    });
    watch('default-period', () => {
      this._currentPeriod = this._settings.get_string('default-period');
      this._refresh();
    });
    watch('budget-threshold', () => this._updateBudget());
    watch('budget-alert-enabled', () => this._updateBudget());
    watch('disabled-providers', () => {
      if (this._lastPayload) {
        this._updatePanel(this._lastPayload);
        this._updateMenu(this._lastPayload);
      }
    });
  }

  _rebuildPanelButton() {
    const compact = this._settings.get_boolean('compact-mode');
    this._panelLabel.visible = !compact;
    this._updatePanel(this._lastPayload);
  }

  _startRefreshLoop() {
    const interval = this._settings.get_uint('refresh-interval') || 30;
    this._refreshSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
      this._refresh();
      return GLib.SOURCE_CONTINUE;
    });
  }

  _restartRefreshLoop() {
    if (this._refreshSourceId) {
      GLib.Source.remove(this._refreshSourceId);
      this._refreshSourceId = 0;
    }
    this._startRefreshLoop();
  }

  async _refresh() {
    try {
      const payload = await this._dataClient.fetch(this._currentPeriod, this._currentProvider);
      this._lastPayload = payload;
      this._isStale = false;
      this._updatePanel(payload);
      this._updateMenu(payload);
    } catch (e) {
      if (e.message?.includes('cancelled')) return;
      log(`CodeBurn: refresh error: ${e.message}`);
      this._isStale = true;
      if (!this._lastPayload)
        this._showError(e.message);
      else
        this._updatePanel(this._lastPayload);
    }
  }

  _getDisabledProviders() {
    return new Set(this._settings.get_strv('disabled-providers'));
  }

  _filterProviders(providers) {
    if (!providers) return { filtered: {}, cost: 0 };
    const disabled = this._getDisabledProviders();
    const filtered = {};
    let cost = 0;
    for (const [name, val] of Object.entries(providers)) {
      if (!disabled.has(name)) {
        filtered[name] = val;
        cost += val;
      }
    }
    return { filtered, cost };
  }

  _updatePanel(payload) {
    if (!payload) {
      this._panelLabel.text = '$?';
      return;
    }
    const { cost } = this._filterProviders(payload.current?.providers);
    let text = formatCost(cost);
    if (this._isStale)
      text += ' *';
    this._panelLabel.text = text;
  }

  _updateMenu(payload) {
    if (!payload?.current) return;
    const c = payload.current;
    const { filtered, cost } = this._filterProviders(c.providers);

    this._heroItem.label.text = `${formatCost(cost)}  ${c.label || this._currentPeriod}`;
    this._statsItem.label.text = `${c.calls ?? 0} calls · ${c.sessions ?? 0} sessions`;

    this._updateProviders(filtered);
    this._updateActivities(c.topActivities);
    this._updateModels(c.topModels);

    this._cacheItem.label.text = `Cache Hit: ${formatPercentDirect(c.cacheHitPercent)}`;
    this._oneShotItem.label.text = `One-shot Rate: ${c.oneShotRate != null ? formatPercent(c.oneShotRate) : '—'}`;

    this._updateBudget();
  }

  _updateProviders(providers) {
    for (const item of this._providerItems)
      item.destroy();
    this._providerItems = [];

    if (!providers || Object.keys(providers).length === 0) {
      this._providerHeader.visible = false;
      this._providerSeparator.visible = false;
      return;
    }

    this._providerHeader.visible = true;
    this._providerSeparator.visible = true;

    const sorted = Object.entries(providers).sort((a, b) => b[1] - a[1]);
    const headerIndex = this.menu._getMenuItems().indexOf(this._providerHeader);

    for (let i = 0; i < sorted.length; i++) {
      const [name, cost] = sorted[i];
      const item = new PopupMenu.PopupMenuItem(`  ${name}`);
      item.setSensitive(false);

      const costLabel = new St.Label({
        text: formatCost(cost),
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
        style_class: 'codeburn-provider-cost',
      });
      item.add_child(costLabel);

      this.menu.addMenuItem(item, headerIndex + 1 + i);
      this._providerItems.push(item);
    }
  }

  _updateActivities(activities) {
    this._activitiesSection.menu.removeAll();
    if (!activities || activities.length === 0) {
      this._activitiesSection.visible = false;
      return;
    }
    this._activitiesSection.visible = true;
    for (const act of activities.slice(0, 5)) {
      const item = new PopupMenu.PopupMenuItem(`${act.name}  ${formatCost(act.cost)}`);
      item.setSensitive(false);
      this._activitiesSection.menu.addMenuItem(item);
    }
  }

  _updateModels(models) {
    this._modelsSection.menu.removeAll();
    if (!models || models.length === 0) {
      this._modelsSection.visible = false;
      return;
    }
    this._modelsSection.visible = true;
    for (const model of models.slice(0, 5)) {
      const item = new PopupMenu.PopupMenuItem(`${model.name}  ${formatCost(model.cost)}`);
      item.setSensitive(false);
      this._modelsSection.menu.addMenuItem(item);
    }
  }

  _updateBudget() {
    const enabled = this._settings.get_boolean('budget-alert-enabled');
    const threshold = this._settings.get_double('budget-threshold');

    if (!enabled || threshold <= 0 || !this._lastPayload?.current) {
      this._budgetItem.visible = false;
      return;
    }

    const cost = this._lastPayload.current.cost;
    if (cost >= threshold) {
      this._budgetItem.label.text = `⚠ Budget exceeded: ${formatCost(cost)} / ${formatCost(threshold)}`;
      this._budgetItem.visible = true;
    } else {
      this._budgetItem.label.text = `Budget: ${formatCost(cost)} / ${formatCost(threshold)}`;
      this._budgetItem.visible = true;
    }
  }

  _showError(message) {
    this._panelLabel.text = '$?';
    if (message?.includes('not found') || message?.includes('No such file')) {
      this._heroItem.label.text = 'CodeBurn CLI not found';
      this._statsItem.label.text = 'Install: npm i -g codeburn';
    } else {
      this._heroItem.label.text = 'Error loading data';
      this._statsItem.label.text = message?.substring(0, 80) || 'Unknown error';
    }
  }

  _openReport() {
    try {
      const argv = ['codeburn', 'report'];
      const launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.NONE);
      launcher.spawnv(argv);
    } catch (e) {
      log(`CodeBurn: failed to open report: ${e.message}`);
    }
  }

  destroy() {
    if (this._refreshSourceId) {
      GLib.Source.remove(this._refreshSourceId);
      this._refreshSourceId = 0;
    }
    this._dataClient?.destroy();
    for (const id of this._settingsChangedIds)
      this._settings.disconnect(id);
    this._settingsChangedIds = [];
    super.destroy();
  }
});
