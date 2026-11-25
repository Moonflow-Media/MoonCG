import { computed, defineComponent, h, onMounted, watch } from 'vue';
import { useBundles } from '../stores/bundles.js';
import { type BackupInfo, type BundleBackups, jobOver, useInstalls } from '../stores/installs.js';
import { useOnAir } from '../stores/onAir.js';
import { sure } from './admin.js';

/** Why a backup was made, as the list says it. */
const REASONS: Record<BackupInfo['reason'], string> = {
  update: 'before an update',
  remove: 'when it was removed',
  restore: 'when another backup was restored',
};

const when = (time: string) => {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? time : date.toLocaleString();
};

/**
 * The backups of every bundle, also of one that was removed and is listed nowhere else, and
 * the way to put one back. Drawn only for those who may manage bundles.
 */
export const BundleBackupsCard = defineComponent({
  name: 'BundleBackupsCard',
  setup() {
    const bundles = useBundles();
    const installs = useInstalls();
    const onAir = useOnAir();
    onMounted(() => void installs.loadBackups());
    // An update, a removal or a restore that ends changes what is kept: the list is read again.
    const ended = computed(() =>
      installs.jobs
        .filter((job) => job.operation !== 'stage' && jobOver(job))
        .map((job) => job.id)
        .join(),
    );
    watch(ended, () => void installs.loadBackups());

    const restore = (of: BundleBackups, backup: BackupInfo) => {
      const installed = bundles.list.find((bundle) => bundle.name === of.name);
      const what = installed
        ? `The installed version ${installed.version ?? ''} is stopped and moved to the backups; it comes back if the restored one does not start.`
        : 'It is installed again and started.';
      const used = 'This backup is used up: it is put in place and no longer listed.';
      if (
        !sure(`Restore "${of.name}" ${backup.version} from ${when(backup.time)}? ${what} ${used}`)
      ) {
        return;
      }
      // Replacing what runs is what the lock is about; bringing back a removed bundle is not.
      const override = installed ? onAir.overrideFor(`Restore "${of.name}"`) : false;
      if (override !== undefined) void installs.restore(of.name, backup.id, override);
    };

    const entry = (of: BundleBackups) =>
      h('div', { key: of.name, class: 'backup-row', 'data-backup-of': of.name }, [
        h('div', { class: 'backup-name' }, [
          h('strong', of.name),
          of.installed ? null : h('span', { class: 'badge warn' }, 'removed'),
        ]),
        h(
          'ul',
          { class: 'backup-list' },
          of.backups.map((backup) =>
            h('li', { key: backup.id }, [
              h('span', { class: 'backup-version' }, backup.version),
              h('span', { class: 'muted' }, `${when(backup.time)}, ${REASONS[backup.reason]}`),
              h(
                'button',
                {
                  type: 'button',
                  class: 'small',
                  disabled: installs.busy(of.name),
                  onClick: () => restore(of, backup),
                },
                'Restore',
              ),
            ]),
          ),
        ),
      ]);

    return () =>
      h('section', { class: 'card backups', 'data-backups': '' }, [
        h('div', { class: 'card-head' }, [h('h2', 'Backups')]),
        h('div', { class: 'card-body' }, [
          installs.backupsProblem
            ? h('p', { class: 'problem', role: 'alert' }, installs.backupsProblem)
            : null,
          installs.backups.length === 0
            ? h(
                'p',
                { class: 'empty' },
                bundles.backupsKept === 0
                  ? 'No backups: this server keeps none.'
                  : 'No backups yet. An update or a removal keeps the version it replaces here.',
              )
            : installs.backups.map(entry),
        ]),
      ]);
  },
});
