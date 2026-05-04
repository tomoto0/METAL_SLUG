/**
 * UIManager - HUD / overlays / combat feedback
 */
export class UIManager {
    constructor(camera) {
        this.camera = camera;

        this.scoreEl = document.getElementById('score');
        this.timeEl = document.getElementById('time-display');
        this.waveEl = document.getElementById('wave-display');
        this.killsEl = document.getElementById('kills-display');
        this.armsEl = document.getElementById('arms-display');
        this.bombEl = document.getElementById('bomb-display');
        this.hpFillEl = document.getElementById('hp-bar-fill');
        this.hpPipsEl = document.getElementById('hp-pips');
        this.comboEl = document.getElementById('combo-display');
        this.waveAnnounce = document.getElementById('wave-announce');
        this.waveAnnounceText = document.getElementById('wave-announce-text');
        this.waveAnnounceDesc = document.getElementById('wave-announce-desc');
        this.stageDisplay = document.getElementById('stage-display');
        this.stageSubDisplay = document.getElementById('stage-sub-display');
        this.gameOverEl = document.getElementById('game-over-screen');
        this.finalScoreEl = document.getElementById('final-score');
        this.finalKillsEl = document.getElementById('final-kills');
        this.finalWaveEl = document.getElementById('final-wave');
        this.killFeedEl = document.getElementById('kill-feed');
        this.scorePopupsEl = document.getElementById('score-popups');
        this.missionStartEl = document.getElementById('mission-start');
        this.missionStartSubEl = document.getElementById('mission-start-sub');
        this.damageFlashEl = document.getElementById('damage-flash');
        this.impactFlashEl = document.getElementById('impact-flash');
        this.scrollProgressFill = document.getElementById('scroll-progress-fill');
        this.scrollProgressMarker = document.getElementById('scroll-progress-marker');

        this.weaponVulcanEl = document.getElementById('weapon-vulcan');
        this.weaponCannonEl = document.getElementById('weapon-cannon');
        this.weaponVulcanAmmoEl = document.getElementById('weapon-vulcan-ammo');
        this.weaponCannonAmmoEl = document.getElementById('weapon-cannon-ammo');

        this.dashMeterFill = document.getElementById('dash-meter-fill');
        this.dashStateEl = document.getElementById('dash-state');
        this.chargeMeterFill = document.getElementById('charge-meter-fill');
        this.chargeStateEl = document.getElementById('charge-state');

        this.bossHpContainer = document.getElementById('boss-hp-container');
        this.bossHpBar = document.getElementById('boss-hp-bar');

        this.aimIndicator = document.getElementById('aim-indicator');
        this.aimLine = document.getElementById('aim-line');
        this.aimDot = document.getElementById('aim-dot');
        this.aimArcBg = document.getElementById('aim-arc-bg');
        this.aimAngleText = document.getElementById('aim-angle-text');
        this.aimModeText = document.getElementById('aim-mode-text');

        this.lockOnReticleEl = document.getElementById('lock-on-reticle');
        this._lockReticleVec = null;

        this.comboCount = 0;
        this.comboTimer = 0;
        this.comboTimeout = 2.0;
        this.maxCombo = 0;

        this.killFeedQueue = [];
        this.itemPickupQueue = [];
        this.waveAnnounceTimer = 0;
        this.scorePopups = [];
        this.damageFlashTimer = 0;
        this.displayScore = 0;
        this.targetScore = 0;
        this.gameTime = 0;

        this.waveNames = [
            'FIRST CONTACT',
            'CLOSE QUARTERS',
            'ARMORED THREAT',
            'HEAVY ASSAULT',
            'AIR RAID',
            'TOTAL WAR',
            'SKY DOMINION',
            'BOSS CROSSROAD',
            'UNDEAD CHARGE',
            'STORM STRIKE',
            'IRON PHALANX',
            'OVERDRIVE FRONT',
            'SCORCHED MARCH',
            'SANDSTORM LINE',
            'BLOOD BRIGADE',
            'FORTRESS BREAK',
            'DOOM LEGION',
            'ARMORED RAIDERS',
            'DEMOLITION FIRELINE',
            'GUNSHIP MAELSTROM',
            'SIEGE ENCIRCLEMENT',
            'LAST DEFENSE GRID',
            'ETERNAL ONSLAUGHT',
        ];

        this.stageNames = [
            'DESERT FRONT',
            'SHATTERED OUTPOST',
            'IRON CANYON',
            'RED WADI',
            'SKYBREACH',
            'FORTRESS LINE',
            'ASHEN STRAIT',
            'BOSS FURNACE',
            'RUINED CATACOMB',
            'THUNDER PASS',
            'STEEL DELTA',
            'SCARLAND',
            'DUST HARBOR',
            'GALE RIDGE',
            'REBEL CITADEL',
            'BLACK SUN KEEP',
            'INFERNO LOOP',
            'RAVEN YARD',
            'BLASTWORKS',
            'SKY CITADEL',
            'TITAN APPROACH',
            'OBSIDIAN GRID',
            'ENDLESS FRONT',
        ];

        this._buildHpPips();
        this._initAimArc();
    }

    update(dt, gameManager, player) {
        this.gameTime += dt;

        if (this.comboCount > 0) {
            this.comboTimer -= dt;
            if (this.comboTimer <= 0) {
                this.comboCount = 0;
                this._hideCombo();
            }
        }

        if (this.waveAnnounceTimer > 0) {
            this.waveAnnounceTimer -= dt;
            if (this.waveAnnounceTimer <= 0) {
                this._hideWaveAnnounce();
            }
        }

        if (this.damageFlashTimer > 0) {
            this.damageFlashTimer -= dt;
            if (this.damageFlashEl) {
                this.damageFlashEl.style.opacity = Math.max(0, this.damageFlashTimer / 0.3);
            }
        }

        this.targetScore = gameManager.score;
        if (this.displayScore < this.targetScore) {
            const diff = this.targetScore - this.displayScore;
            this.displayScore += Math.max(1, Math.ceil(diff * dt * 8));
            if (this.displayScore > this.targetScore) this.displayScore = this.targetScore;
        }

        this.scorePopups = this.scorePopups.filter(popup => {
            popup.age += dt;
            if (popup.age > popup.maxAge) {
                popup.el.remove();
                return false;
            }
            return true;
        });

        this.killFeedQueue = this.killFeedQueue.filter(item => {
            item.age += dt;
            if (item.age > 3.0) {
                item.el.style.opacity = '0';
                setTimeout(() => item.el.remove(), 250);
                return false;
            }
            return true;
        });

        this._updateScore(this.displayScore);
        this._updateTime();
        this._updateWave(gameManager.getCurrentWave());
        this._updateKills(gameManager.kills);
        this._updateHpBar(player.hp, player.maxHp);
        this._updateArms(player);
        this._updateBomb(player);
        this._updateDash(player);
        this._updateCharge(player);
        this._updateWeapons(player);
        this._updateAimIndicator(player);
        this._updateLockOnReticle(player);
    }

    _updateLockOnReticle(player) {
        const el = this.lockOnReticleEl;
        if (!el || !this.camera) return;
        const target = player && player.lockTarget;
        const pos = player && player.lockTargetPos;
        if (!target || !pos) {
            if (el.classList.contains('visible')) el.classList.remove('visible');
            return;
        }

        // 3D → 2D 投影 (NDC) - pos は THREE.Vector3。Vector3 を再利用して GC を抑える
        if (!this._lockReticleVec) this._lockReticleVec = pos.clone();
        const v = this._lockReticleVec;
        v.copy(pos);
        v.project(this.camera);
        // NDC z > 1 はカメラ後方
        if (v.z > 1 || v.z < -1) {
            if (el.classList.contains('visible')) el.classList.remove('visible');
            return;
        }
        const w = window.innerWidth;
        const h = window.innerHeight;
        const sx = (v.x * 0.5 + 0.5) * w;
        const sy = (1 - (v.y * 0.5 + 0.5)) * h;
        // 中央配置: 64px の半分オフセット
        const lx = Math.round(sx - 32);
        const ly = Math.round(sy - 32);
        el.style.setProperty('--lx', `${lx}px`);
        el.style.setProperty('--ly', `${ly}px`);
        el.style.transform = `translate(${lx}px, ${ly}px)`;
        if (!el.classList.contains('visible')) el.classList.add('visible');

        // チャージ中はカラー変化
        const charging = !!player.cannonCharging;
        el.classList.toggle('charging', charging);
    }

    updateScrollProgress(progress) {
        const pct = Math.min(100, Math.max(0, progress * 100));
        if (this.scrollProgressFill) {
            this.scrollProgressFill.style.width = `${pct}%`;
        }
        if (this.scrollProgressMarker) {
            this.scrollProgressMarker.style.left = `${pct}%`;
        }
    }

    onEnemyKilled(enemyType, subType, scoreValue, worldPos) {
        this.comboCount++;
        this.comboTimer = this.comboTimeout;
        if (this.comboCount > this.maxCombo) this.maxCombo = this.comboCount;

        // コンボ倍率（Metal Slug には無いが本作オリジナル。敵スコアを引き上げた分、
        // 倍率は控えめにしてインフレを防ぐ）
        let bonusMultiplier = 1;
        if (this.comboCount >= 3) bonusMultiplier = 1.2;
        if (this.comboCount >= 5) bonusMultiplier = 1.5;
        if (this.comboCount >= 10) bonusMultiplier = 2.0;
        if (this.comboCount >= 20) bonusMultiplier = 3.0;

        const finalScore = Math.floor(scoreValue * bonusMultiplier);

        if (this.comboCount >= 2) {
            this._showCombo(this.comboCount, bonusMultiplier);
        }

        // コンボマイルストーンバナー (Feature 5)
        if (this.comboCount === 5)  this._spawnCenterBanner('5 HIT COMBO!', '#FFD700');
        if (this.comboCount === 10) this._spawnCenterBanner('10 HIT COMBO!', '#FF8822');
        if (this.comboCount === 20) this._spawnCenterBanner('20 HIT RAMPAGE!', '#FF2222');
        if (enemyType === 'aircraft') this._spawnCenterBanner('AIR COMBO!', '#55DDFF');

        // Combo milestone burst flash
        if (this.comboCount === 5 || this.comboCount === 10 || this.comboCount === 20) {
            this.triggerImpactFlash(1.2, true);
        }

        this._addKillFeed(enemyType, subType, finalScore);
        this._addScorePopup(finalScore, worldPos, this.comboCount >= 3);

        return finalScore;
    }

    // Feature 1: POW救出バナー
    showRescueBanner(reward) {
        const label = {
            weapon_H: 'HEAVY MACHINE GUN!',
            weapon_R: 'ROCKET LAUNCHER!',
            grenade:  '+5 BOMBS!',
            score_big: '+5000 PTS!',
        }[reward] || 'RESCUED!';
        this._spawnCenterBanner(`POW! ${label}`, '#FFEE44');
    }

    showItemPickup(type, bonus = 0) {
        const info = this._getItemPickupInfo(type, bonus);
        const host = document.getElementById('ui-overlay') || document.body;

        const el = document.createElement('div');
        el.className = 'item-pickup-banner';
        el.style.setProperty('--pickup-color', info.color);
        const stack = Math.min(this.itemPickupQueue.length, 2);
        el.style.setProperty('--pickup-offset', `${stack * 48}px`);
        el.style.setProperty('--pickup-mobile-offset', `${stack * 58}px`);
        el.innerHTML = `
            <span class="item-pickup-code">${info.code}</span>
            <span class="item-pickup-title">${info.title}</span>
            <span class="item-pickup-detail">${info.detail}</span>
        `;
        host.appendChild(el);

        const entry = { el, timer: null };
        entry.timer = setTimeout(() => {
            if (el.parentNode) el.remove();
            this.itemPickupQueue = this.itemPickupQueue.filter(item => item !== entry);
        }, 1350);
        this.itemPickupQueue.push(entry);

        while (this.itemPickupQueue.length > 3) {
            const old = this.itemPickupQueue.shift();
            clearTimeout(old.timer);
            if (old.el.parentNode) old.el.remove();
        }
    }

    _getItemPickupInfo(type, bonus = 0) {
        const table = {
            health:      { code: '[MED KIT]', title: 'LIFE RESTORED', detail: '+30 HP', color: '#66ff88' },
            grenade:     { code: '[BOMB]', title: 'GRENADE STOCK', detail: '+10 BOMBS', color: '#ff9b42' },
            score:       { code: '[MEDAL]', title: 'BONUS SCORE', detail: `+${bonus || 300} PTS`, color: '#ffdd44' },
            score_big:   { code: '[TREASURE]', title: 'BIG BONUS', detail: `+${bonus || 5000} PTS`, color: '#ffe96b' },
            weapon_H:    { code: '[H]', title: 'HEAVY MACHINE GUN', detail: '200 ROUNDS', color: '#ffcc33' },
            weapon_R:    { code: '[R]', title: 'ROCKET LAUNCHER', detail: '30 ROCKETS', color: '#ff5544' },
            weapon_F:    { code: '[F]', title: 'FLAME SHOT', detail: '50 BURSTS', color: '#ff7a22' },
            weapon_S:    { code: '[S]', title: 'SHOTGUN', detail: '30 SHELLS', color: '#44e0aa' },
            power_BIG:   { code: '[P]', title: 'BIG SHOT', detail: '12 SEC BOOST', color: '#ff66bb' },
            power_SPREAD:{ code: '[3]', title: '3-WAY FIRE', detail: '14 SEC BOOST', color: '#55d8ff' },
            power_FLAME: { code: '[F]', title: 'FLAME BOOST', detail: '10 SEC BOOST', color: '#ff8b28' },
        };
        return table[type] || { code: '[ITEM]', title: 'SUPPLY GET', detail: 'EFFECT ACTIVE', color: '#ffffff' };
    }

    // Feature 5: 中央バナー表示
    _spawnCenterBanner(text, color = '#FFEE44') {
        const el = document.createElement('div');
        el.className = 'bonus-banner';
        el.textContent = text;
        el.style.color = color;
        document.body.appendChild(el);
        setTimeout(() => { if (el.parentNode) el.remove(); }, 1400);
    }

    showMissionStart() {
        if (!this.missionStartEl) return;
        this.missionStartEl.style.display = 'flex';
        if (this.missionStartSubEl && this.stageDisplay) {
            this.missionStartSubEl.textContent = this.stageDisplay.textContent;
        }
        this.missionStartEl.classList.remove('mission-animate');
        void this.missionStartEl.offsetWidth;
        this.missionStartEl.classList.add('mission-animate');
        setTimeout(() => {
            if (this.missionStartEl) this.missionStartEl.style.display = 'none';
        }, 2400);
    }

    triggerDamageFlash() {
        this.damageFlashTimer = 0.3;
        if (this.damageFlashEl) {
            this.damageFlashEl.style.opacity = '1';
        }
    }

    triggerImpactFlash(intensity = 1, combo = false) {
        if (!this.impactFlashEl) return;
        this.impactFlashEl.classList.remove('pulse', 'combo-burst');
        // Force reflow so CSS animation can be re-triggered
        void this.impactFlashEl.offsetWidth;
        this.impactFlashEl.classList.add(combo ? 'combo-burst' : 'pulse');
        this.impactFlashEl.style.setProperty('--impact-intensity', String(intensity));
    }

    announceWave(waveNumber) {
        this._showWaveAnnounce(waveNumber);
    }

    showBossHp(hp, maxHp) {
        if (this.bossHpContainer) this.bossHpContainer.style.display = 'block';
        if (this.bossHpBar) {
            this.bossHpBar.style.width = `${Math.max(0, (hp / maxHp) * 100)}%`;
        }
    }

    hideBossHp() {
        if (this.bossHpContainer) this.bossHpContainer.style.display = 'none';
    }

    showGameOver(score, kills, wave, maxCombo) {
        if (!this.gameOverEl) return;
        this.gameOverEl.style.display = 'flex';
        if (this.finalScoreEl) this.finalScoreEl.textContent = score.toLocaleString();
        if (this.finalKillsEl) this.finalKillsEl.textContent = String(kills);
        if (this.finalWaveEl) this.finalWaveEl.textContent = String(wave);
        const comboEl = document.getElementById('final-combo');
        if (comboEl) comboEl.textContent = String(maxCombo);
    }

    hideGameOver() {
        if (this.gameOverEl) this.gameOverEl.style.display = 'none';
    }

    reset() {
        this.comboCount = 0;
        this.comboTimer = 0;
        this.maxCombo = 0;
        this.displayScore = 0;
        this.targetScore = 0;
        this.damageFlashTimer = 0;
        this.gameTime = 0;
        this._hideCombo();
        this.hideGameOver();
        this.hideBossHp();

        this.scorePopups.forEach(popup => popup.el.remove());
        this.scorePopups = [];
        this.killFeedQueue.forEach(item => item.el.remove());
        this.killFeedQueue = [];
        this.itemPickupQueue.forEach(item => {
            clearTimeout(item.timer);
            if (item.el.parentNode) item.el.remove();
        });
        this.itemPickupQueue = [];

        if (this.damageFlashEl) this.damageFlashEl.style.opacity = '0';
        if (this.chargeMeterFill) this.chargeMeterFill.style.transform = 'scaleX(0)';
        if (this.dashMeterFill) this.dashMeterFill.style.transform = 'scaleX(1)';
    }

    _updateScore(score) {
        if (this.scoreEl) {
            this.scoreEl.textContent = String(Math.floor(score)).padStart(7, '0');
        }
    }

    _updateTime() {
        if (!this.timeEl) return;
        const totalSec = Math.floor(this.gameTime);
        const min = String(Math.floor(totalSec / 60)).padStart(2, '0');
        const sec = String(totalSec % 60).padStart(2, '0');
        this.timeEl.textContent = `${min}:${sec}`;
    }

    _updateWave(wave) {
        if (this.waveEl) {
            this.waveEl.textContent = String(wave);
        }

        const index = Math.max(0, Math.min(this.waveNames.length - 1, wave - 1));
        if (this.stageDisplay) this.stageDisplay.textContent = this.stageNames[index];
        if (this.stageSubDisplay) this.stageSubDisplay.textContent = this.waveNames[index];
    }

    _updateKills(kills) {
        if (this.killsEl) {
            this.killsEl.textContent = String(kills).padStart(3, '0');
        }
    }

    _updateHpBar(hp, maxHp) {
        if (!this.hpFillEl) return;
        const pct = Math.max(0, hp / maxHp) * 100;
        this.hpFillEl.style.width = `${pct}%`;

        if (pct > 60) {
            this.hpFillEl.style.background = 'linear-gradient(90deg, #97ff86, #3ab054)';
        } else if (pct > 30) {
            this.hpFillEl.style.background = 'linear-gradient(90deg, #ffd760, #ff8d36)';
        } else {
            this.hpFillEl.style.background = 'linear-gradient(90deg, #ff7f61, #d22f2b)';
        }

        this.hpFillEl.style.animation = pct <= 25 ? 'hpBlink 0.4s ease-in-out infinite' : 'none';
        this._updateHpPips(pct);
    }

    _updateArms(player) {
        if (!this.armsEl) return;
        if (player.powerUp) {
            const names = { BIG: 'BIG-SHOT', SPREAD: '3-WAY', FLAME: 'FLAME' };
            const colors = { BIG: '#FF44AA', SPREAD: '#44CCFF', FLAME: '#FF7711' };
            const sec = Math.max(0, player.powerUpTimer).toFixed(1);
            this.armsEl.textContent = `${names[player.powerUp] || player.powerUp} ${sec}s`;
            this.armsEl.style.color = colors[player.powerUp] || '#FFFFFF';
        } else if (player.specialWeapon) {
            const names = { H: 'H.M.GUN', R: 'ROCKET', F: 'FLAME', S: 'SHOTGUN' };
            this.armsEl.textContent = `${names[player.specialWeapon] || player.specialWeapon} ×${player.specialAmmo}`;
            this.armsEl.style.color = '#FFCC33';
        } else {
            this.armsEl.textContent = player.cannonCharging ? 'CANNON' : 'VULCAN';
            this.armsEl.style.color = '';
        }
    }

    _updateBomb(player) {
        if (!this.bombEl) return;
        const grenades = player.grenadeCount !== undefined ? player.grenadeCount : 10;
        this.bombEl.textContent = String(grenades).padStart(2, '0');
    }

    _updateDash(player) {
        const ratio = 1 - Math.max(0, player.dashCooldown) / Math.max(0.01, player.dashCooldownMax);
        if (this.dashMeterFill) {
            this.dashMeterFill.style.transform = `scaleX(${ratio.toFixed(3)})`;
        }
        if (this.dashStateEl) {
            this.dashStateEl.textContent = player.dashDuration > 0 ? 'BOOST' : (player.dashCooldown > 0 ? 'RECOVER' : 'READY');
        }
    }

    _updateCharge(player) {
        const CHARGE_MIN_RATIO = 0.5;
        const ratio = player.cannonCharging
            ? Math.max(0, Math.min(1, player.cannonCharge / player.cannonChargeMax))
            : 0;
        if (this.chargeMeterFill) {
            this.chargeMeterFill.style.transform = `scaleX(${ratio.toFixed(3)})`;
            // 発射可能閾値でゲージ色が変化
            if (player.cannonCharging) {
                if (ratio >= 0.75) {
                    // 高チャージ: 青白パルス
                    this.chargeMeterFill.className = 'resource-meter-fill charge-fill charge-high';
                } else if (ratio >= CHARGE_MIN_RATIO) {
                    // 発射可能: 明るいオレンジ
                    this.chargeMeterFill.className = 'resource-meter-fill charge-fill charge-ready';
                } else {
                    // 閾値未満: デフォルト（暗い）
                    this.chargeMeterFill.className = 'resource-meter-fill charge-fill charge-low';
                }
            } else {
                this.chargeMeterFill.className = 'resource-meter-fill charge-fill';
            }
        }
        if (this.chargeStateEl) {
            if (player.cannonCharging) {
                if (ratio >= CHARGE_MIN_RATIO) {
                    this.chargeStateEl.textContent = `${Math.round(ratio * 100)}% ▶ FIRE`;
                    this.chargeStateEl.style.color = ratio >= 0.75 ? '#66CCFF' : '#FFAA33';
                } else {
                    this.chargeStateEl.textContent = `${Math.round(ratio * 100)}% CHARGING`;
                    this.chargeStateEl.style.color = '';
                }
            } else {
                this.chargeStateEl.textContent = 'READY';
                this.chargeStateEl.style.color = '';
            }
        }
    }

    _updateWeapons(player) {
        if (this.weaponVulcanEl) this.weaponVulcanEl.classList.toggle('active', !player.cannonCharging);
        if (this.weaponCannonEl) this.weaponCannonEl.classList.toggle('active', !!player.cannonCharging);
        if (this.weaponVulcanAmmoEl) this.weaponVulcanAmmoEl.textContent = player.cannonCharging ? 'SAFE' : 'HOLD';
        if (this.weaponCannonAmmoEl) {
            this.weaponCannonAmmoEl.textContent = player.cannonCharging
                ? `${Math.round((player.cannonCharge / player.cannonChargeMax) * 100)}%`
                : 'READY';
        }
    }

    _showCombo(count, multiplier) {
        if (!this.comboEl) return;
        this.comboEl.style.display = 'block';

        let countColor = '#FFD700';
        let multiColor = '#FFB067';
        if (count >= 20) {
            countColor = '#FF6BD6';
            multiColor = '#FF6BD6';
        } else if (count >= 10) {
            countColor = '#FF7C4A';
            multiColor = '#FFD46B';
        } else if (count >= 5) {
            countColor = '#FFD75A';
            multiColor = '#FF9F57';
        }

        this.comboEl.innerHTML = `
            <span class="combo-count" style="color:${countColor}">${count}</span>
            <span class="combo-label">COMBO</span>
            <span class="combo-multi" style="color:${multiColor}">MULTI x${multiplier.toFixed(1)}</span>
        `;
        this.comboEl.classList.remove('combo-pulse');
        void this.comboEl.offsetWidth;
        this.comboEl.classList.add('combo-pulse');
    }

    _hideCombo() {
        if (this.comboEl) this.comboEl.style.display = 'none';
    }

    _showWaveAnnounce(waveNumber) {
        if (!this.waveAnnounce) return;
        this.waveAnnounceTimer = 3.0;
        const index = Math.max(0, Math.min(this.waveNames.length - 1, waveNumber - 1));
        const name = this.waveNames[index];

        if (this.waveAnnounceText) {
            this.waveAnnounceText.textContent = `WAVE ${waveNumber}`;
        }
        if (this.waveAnnounceDesc) {
            this.waveAnnounceDesc.textContent = name;
        }
        if (this.stageDisplay) {
            this.stageDisplay.textContent = this.stageNames[index];
        }
        if (this.stageSubDisplay) {
            this.stageSubDisplay.textContent = name;
        }

        this.waveAnnounce.style.display = 'flex';
        this.waveAnnounce.classList.remove('wave-slide');
        void this.waveAnnounce.offsetWidth;
        this.waveAnnounce.classList.add('wave-slide');
    }

    _hideWaveAnnounce() {
        if (this.waveAnnounce) this.waveAnnounce.style.display = 'none';
    }

    _addKillFeed(enemyType, subType, score) {
        if (!this.killFeedEl) return;

        const names = {
            'infantry-rifle': 'RIFLEMAN',
            'infantry-knife': 'KNIFEMAN',
            'infantry-rocket': 'ROCKETEER',
            'infantry-shield': 'SHIELDMAN',
            'infantry-grenade': 'GRENADIER',
            'infantry-machinegun': 'GUNNER',
            'infantry-officer': 'OFFICER',
            'infantry-flamethrower': 'FLAMER',
            'infantry-mummy': 'MUMMY',
            'infantry-sniper': 'SNIPER',
            'infantry-hunter': 'HUNTER',
            'infantry-ninja': 'NINJA',
            'infantry-juggernaut': 'JUGGERNAUT',
            'infantry-commando': 'COMMANDO',
            'infantry-demolition': 'DEMOLITION',
            'tank-light': 'LIGHT TANK',
            'tank-heavy': 'HEAVY TANK',
            'tank-flak': 'FLAK TANK',
            'tank-siege': 'SIEGE TANK',
            'aircraft-scout_heli': 'SCOUT HELI',
            'aircraft-attack_heli': 'ATTACK HELI',
            'aircraft-bomber': 'BOMBER',
            'aircraft-fighter': 'FIGHTER',
            'aircraft-drone': 'RAZOR DRONE',
            'aircraft-interceptor': 'INTERCEPTOR',
            'aircraft-gunship': 'GUNSHIP',
            'aircraft-tomahawk': 'TOMAHAWK',
        };

        const key = `${enemyType}-${subType}`;
        const name = names[key] || subType.toUpperCase();

        const el = document.createElement('div');
        el.className = 'kill-feed-item';
        el.innerHTML = `<span class="kf-name">${name}</span><span class="kf-score">+${score}</span>`;
        this.killFeedEl.appendChild(el);

        this.killFeedQueue.push({ el, age: 0 });
        while (this.killFeedQueue.length > 6) {
            const old = this.killFeedQueue.shift();
            old.el.remove();
        }
    }

    _addScorePopup(score, worldPos, isCombo) {
        if (!this.scorePopupsEl || !this.camera) return;

        const screenPos = this._worldToScreen(worldPos);
        if (!screenPos) return;

        const el = document.createElement('div');
        el.className = `score-popup${isCombo ? ' combo' : ''}`;
        el.textContent = `+${score}`;
        el.style.left = `${screenPos.x}px`;
        el.style.top = `${screenPos.y}px`;
        this.scorePopupsEl.appendChild(el);

        this.scorePopups.push({ el, age: 0, maxAge: 1.2 });
    }

    _worldToScreen(worldPos) {
        if (!this.camera) return null;
        const vector = worldPos.clone();
        vector.y += 2;
        vector.project(this.camera);
        if (vector.z > 1) return null;

        return {
            x: (vector.x * 0.5 + 0.5) * window.innerWidth,
            y: (-vector.y * 0.5 + 0.5) * window.innerHeight,
        };
    }

    _initAimArc() {
        if (!this.aimArcBg) return;

        const cx = 60;
        const cy = 66;
        const r = 46;
        const startAngle = 205 * Math.PI / 180;
        const endAngle = 335 * Math.PI / 180;
        const steps = 28;
        let d = '';

        for (let i = 0; i <= steps; i++) {
            const t = startAngle + (endAngle - startAngle) * (i / steps);
            const x = cx + Math.cos(t) * r;
            const y = cy + Math.sin(t) * r;
            d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
        }

        this.aimArcBg.setAttribute('d', d);
    }

    _updateAimIndicator(player) {
        if (!this.aimLine || !this.aimDot || !this.aimAngleText || !this.aimModeText) return;

        const angleDeg = player.aimAngleDeg || 0;
        const aimMode = player.aimMode || 'mouse';
        const facingRight = !!player.facingRight;

        const cx = 60;
        const cy = 66;
        const lineLen = 42;
        const angleRad = angleDeg * Math.PI / 180;
        const dir = facingRight ? 1 : -1;
        const ex = cx + Math.cos(angleRad) * lineLen * dir;
        const ey = cy - Math.sin(angleRad) * lineLen;

        this.aimLine.setAttribute('x1', cx);
        this.aimLine.setAttribute('y1', cy);
        this.aimLine.setAttribute('x2', ex.toFixed(1));
        this.aimLine.setAttribute('y2', ey.toFixed(1));
        this.aimDot.setAttribute('cx', ex.toFixed(1));
        this.aimDot.setAttribute('cy', ey.toFixed(1));

        this.aimAngleText.textContent = `${facingRight ? 'R' : 'L'} ${angleDeg}\u00b0`;
        const locked = !!(player && player.lockTarget);
        this.aimModeText.textContent = locked ? 'LOCK ON' : 'SCAN';

        if (this.aimIndicator) {
            this.aimIndicator.classList.toggle('active-keyboard', locked);
        }

        const lineColor = locked ? '#FF3322' : '#FF7442';
        this.aimLine.setAttribute('stroke', lineColor);
        this.aimDot.setAttribute('fill', lineColor);
    }

    _buildHpPips() {
        if (!this.hpPipsEl) return;
        this.hpPipsEl.innerHTML = '';
        for (let i = 0; i < 10; i++) {
            const pip = document.createElement('span');
            pip.className = 'hp-pip active';
            this.hpPipsEl.appendChild(pip);
        }
    }

    _updateHpPips(pct) {
        if (!this.hpPipsEl) return;
        const activeCount = Math.max(0, Math.ceil((pct / 100) * 10));
        [...this.hpPipsEl.children].forEach((pip, index) => {
            pip.classList.toggle('active', index < activeCount);
            pip.classList.toggle('low', pct <= 30 && index < activeCount);
        });
    }
}
