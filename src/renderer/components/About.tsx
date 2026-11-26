import { useEffect, useRef, useState } from 'react';
import type { AboutInfo, LatestCheck } from '@shared/ipc';
import { showToast } from '../lib/actions';
import { writeClipboard } from '../lib/clipboard';
import { errorMessage } from '../lib/errors';
import { m } from '../lib/i18n';
import { setState, useStore } from '../lib/store';
import { DialogHead, Modal } from './ui';
import logoMark from '../../../resources/logo-mark.png';

type CheckState = { status: 'idle' } | { status: 'checking' } | LatestCheck;

/** The About window: version, runtime, license, repository and, only when the person asks, the newest release. */
export function AboutDialog() {
  const open = useStore((s) => s.about);
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [check, setCheck] = useState<CheckState>({ status: 'idle' });
  // bumped on every opening and closing: a check answered after that is dropped
  const opening = useRef(0);

  useEffect(() => {
    opening.current += 1;
    if (!open) return;
    // every opening starts clean: the check is never run for the person
    setCheck({ status: 'idle' });
    let cancelled = false;
    window.cais.app
      .about()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch((error) => {
        showToast(errorMessage(error));
        setState({ about: false });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;
  const t = m().about;
  const close = () => {
    opening.current += 1;
    setCheck({ status: 'idle' });
    setState({ about: false });
  };

  const runCheck = () => {
    const mine = opening.current;
    setCheck({ status: 'checking' });
    window.cais.app
      .checkLatest()
      .then((result) => {
        if (opening.current === mine) setCheck(result);
      })
      .catch(() => {
        if (opening.current === mine) setCheck({ status: 'unavailable' });
      });
  };
  const openLink = (target: 'repository' | 'releases' | 'release') => {
    window.cais.app.openLink(target).catch((error) => showToast(errorMessage(error)));
  };
  const copyInfo = () => {
    if (!info) return;
    writeClipboard(t.copyText({ version: info.version, electron: info.electron, chromium: info.chromium, node: info.node, system: info.system }));
    showToast(t.copied, 'info');
  };

  const rows: [string, string][] = info
    ? [
        [t.labels.electron, info.electron],
        [t.labels.chromium, info.chromium],
        [t.labels.node, info.node],
        [t.labels.system, info.system],
        [t.labels.license, t.licenseValue],
      ]
    : [];

  return (
    <Modal
      title={t.title}
      onClose={close}
      className="about"
      align="center"
      footer={
        <>
          <button className="btn" data-testid="about-copy" disabled={!info} onClick={copyInfo}>
            {t.copy}
          </button>
          <span className="grow" />
          <button className="btn accent" autoFocus data-testid="about-close" onClick={close}>
            {t.close}
          </button>
        </>
      }
    >
      <DialogHead title={t.title} />
      <div className="dialog-body about-body" data-testid="about">
        <img className="about-logo" data-testid="about-logo" src={logoMark} alt="" aria-hidden="true" draggable={false} />
        <div className="about-name">Cais</div>
        <div className="about-version" data-testid="about-version">
          {info ? t.version({ version: info.version }) : ' '}
        </div>
        <div className="about-tagline">{t.tagline}</div>
        <dl className="about-list" data-testid="about-list">
          {rows.map(([label, value]) => (
            <div key={label} className="about-row">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          {info && (
            <div className="about-row">
              <dt>{t.labels.repository}</dt>
              <dd>
                <button className="link-btn" data-testid="about-repository" onClick={() => openLink('repository')}>
                  {info.repository.replace(/^https:\/\//, '')}
                </button>
              </dd>
            </div>
          )}
        </dl>
        <div className="about-update">
          <div className="about-update-head">
            <span>{t.update.heading}</span>
            <button className="btn small" data-testid="about-check" disabled={check.status === 'checking'} onClick={runCheck}>
              {t.update.check}
            </button>
          </div>
          {check.status === 'idle' && <div className="about-hint">{t.update.hint}</div>}
          {check.status !== 'idle' && (
            <div className="about-result" role="status" data-testid="about-check-result" data-status={check.status}>
              {check.status === 'checking' && t.update.checking}
              {check.status === 'current' && t.update.current}
              {check.status === 'newer' && (
                <>
                  <span>{t.update.newer({ latest: check.latest })}</span>{' '}
                  <button className="link-btn" data-testid="about-open-release" onClick={() => openLink('release')}>
                    {t.update.openRelease({ latest: check.latest })}
                  </button>
                </>
              )}
              {check.status === 'unavailable' && (
                <>
                  <span>{t.update.unavailable}</span>{' '}
                  <button className="link-btn" data-testid="about-open-releases" onClick={() => openLink('releases')}>
                    {t.update.openReleases}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
