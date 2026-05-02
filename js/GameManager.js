import * as THREE from 'three';
import { Infantry } from './Infantry.js';
import { EnemyTank } from './EnemyTank.js';
import { Aircraft } from './Aircraft.js';
import { Boss } from './Boss.js';
import { Explosion } from './Explosion.js';
import { ItemDrop } from './ItemDrop.js';
import { POW } from './POW.js';

// 衝突判定の per-frame アロケーションを抑えるための共有テンポラリ。
// 1 関数の中で完結する一時ベクトルにのみ使う（呼び出し境界を超えて保持しない）。
const _hitTmpV = new THREE.Vector3();
const _hitTmpSeg = new THREE.Vector3();
const _hitTmpDelta = new THREE.Vector3();

/**
 * ゲーム全体の管理（サイドスクロール版）
 * - 敵は主に画面右側からスポーン
 * - スクロール位置に連動した敵配置
 */
export class GameManager {
    constructor(scene) {
        this.scene = scene;
        this.enemies = [];
        this.effects = [];
        this.items = [];
        this.score = 0;
        this.kills = 0;
        this.elapsedTime = 0;
        this.spawnTimer = 0;
        this.cleanupTimer = 0;
        this.waveIndex = 0;
        this.enemiesSpawnedInWave = 0;
        this.gameOver = false;

        // コールバック
        this.onScoreChange = null;
        this.onPlayerHit = null;
        this.onGameOver = null;
        this.onWaveChange = null;
        this.onEnemyKilled = null;
        this.onScreenShake = null;

        // スポーン設定
        this.spawnInterval = 2.0;
        this.maxEnemies = 15;

        // ボス
        this.boss = null;
        this.bossSpawnedWaves = new Set();
        this.onBossHpChange = null;
        this.onBossDefeated = null;
        this.onBossSpawn = null;

        // POW (Feature 1)
        this.pows = [];
        this.powSpawnTimer = 0;
        this.powSpawnInterval = 22.0;
        this.onPowRescued = null;

        // スクロール情報（main.jsから設定される）
        this.getScrollZ = () => 0;
        this.getScrollSpeed = () => 5;

        // ウェーブ定義（23ステージ）
        // 構成: 1〜3 序盤 / 4 中ボス / 5〜7 中盤 / 8 中盤ボス / 9〜12 後半 /
        // 13〜17 終盤拡張 / 18〜22 深部要塞 / 23 無限
        this.waves = [
            // --- Wave 1: 序章（ライフル兵の襲来）---
            {
                duration: 22, spawnInterval: 1.5, maxSimultaneous: 9,
                pool: [{ type: 'infantry', subType: 'rifle', weight: 1 }],
            },
            // --- Wave 2: 突撃部隊（ナイフ・ハンター追加）---
            {
                duration: 25, spawnInterval: 1.35, maxSimultaneous: 11,
                pool: [
                    { type: 'infantry', subType: 'rifle',  weight: 3 },
                    { type: 'infantry', subType: 'knife',  weight: 2 },
                    { type: 'infantry', subType: 'hunter', weight: 1 },
                ],
            },
            // --- Wave 3: 多彩な歩兵（手榴弾・スナイパー）---
            {
                duration: 28, spawnInterval: 1.25, maxSimultaneous: 12,
                pool: [
                    { type: 'infantry', subType: 'rifle',   weight: 3 },
                    { type: 'infantry', subType: 'grenade', weight: 2 },
                    { type: 'infantry', subType: 'knife',   weight: 1 },
                    { type: 'infantry', subType: 'hunter',  weight: 1 },
                    { type: 'infantry', subType: 'sniper',  weight: 1 },
                ],
            },
            // --- Wave 4: ボス戦の前哨戦 + Di-Cokka 中ボス ---
            {
                duration: 35, spawnInterval: 1.2, maxSimultaneous: 12,
                pool: [
                    { type: 'infantry', subType: 'rifle',   weight: 3 },
                    { type: 'infantry', subType: 'grenade', weight: 2 },
                    { type: 'infantry', subType: 'rocket',  weight: 1 },
                    { type: 'tank',     subType: 'light',   weight: 1 },
                ],
            },
            // --- Wave 5: 古代の脅威（ミイラ・忍者初登場の混成）---
            {
                duration: 28, spawnInterval: 1.15, maxSimultaneous: 13,
                pool: [
                    { type: 'infantry', subType: 'rifle', weight: 1 },
                    { type: 'infantry', subType: 'mummy', weight: 3 },
                    { type: 'infantry', subType: 'ninja', weight: 2 },
                    { type: 'infantry', subType: 'knife', weight: 1 },
                ],
            },
            // --- Wave 6: 重装部隊（火炎・盾・士官）---
            {
                duration: 30, spawnInterval: 1.2, maxSimultaneous: 14,
                pool: [
                    { type: 'infantry', subType: 'rocket',       weight: 2 },
                    { type: 'infantry', subType: 'shield',       weight: 2 },
                    { type: 'infantry', subType: 'officer',      weight: 1 },
                    { type: 'infantry', subType: 'flamethrower', weight: 2 },
                    { type: 'tank',     subType: 'light',        weight: 1 },
                ],
            },
            // --- Wave 7: 制空権争い（航空戦力多投 + 屋上狙撃）---
            {
                duration: 32, spawnInterval: 1.2, maxSimultaneous: 15,
                pool: [
                    { type: 'infantry',  subType: 'rifle',          weight: 2 },
                    { type: 'infantry',  subType: 'machinegun',     weight: 1 },
                    { type: 'infantry',  subType: 'rocket',         weight: 1 },
                    { type: 'infantry',  subType: 'sniper',         weight: 1 },
                    { type: 'infantry',  subType: 'perched_sniper', weight: 1 },
                    { type: 'aircraft',  subType: 'scout_heli',     weight: 2 },
                    { type: 'aircraft',  subType: 'attack_heli',    weight: 1 },
                ],
            },
            // --- Wave 8: 中盤ボス Tani Oh（強敵歩兵を伴う）---
            {
                duration: 40, spawnInterval: 1.15, maxSimultaneous: 13,
                pool: [
                    { type: 'infantry', subType: 'machinegun',   weight: 2 },
                    { type: 'infantry', subType: 'flamethrower', weight: 1 },
                    { type: 'infantry', subType: 'shield',       weight: 1 },
                    { type: 'infantry', subType: 'rocket',       weight: 1 },
                ],
            },
            // --- Wave 9: ミイラの大群 + 火炎兵連携 ---
            {
                duration: 30, spawnInterval: 1.05, maxSimultaneous: 16,
                pool: [
                    { type: 'infantry', subType: 'mummy',        weight: 4 },
                    { type: 'infantry', subType: 'flamethrower', weight: 2 },
                    { type: 'infantry', subType: 'sniper',       weight: 1 },
                    { type: 'infantry', subType: 'ninja',        weight: 2 },
                    { type: 'tank',     subType: 'light',        weight: 1 },
                ],
            },
            // --- Wave 10: 全方位空襲（爆撃機・戦闘機 + 屋上スナイパー）---
            {
                duration: 32, spawnInterval: 1.1, maxSimultaneous: 17,
                pool: [
                    { type: 'infantry', subType: 'machinegun',     weight: 1 },
                    { type: 'infantry', subType: 'officer',        weight: 1 },
                    { type: 'infantry', subType: 'rocket',         weight: 1 },
                    { type: 'infantry', subType: 'juggernaut',     weight: 1 },
                    { type: 'infantry', subType: 'perched_sniper', weight: 1 },
                    { type: 'aircraft', subType: 'attack_heli',    weight: 2 },
                    { type: 'aircraft', subType: 'bomber',         weight: 2 },
                    { type: 'aircraft', subType: 'fighter',        weight: 1 },
                ],
            },
            // --- Wave 11: 機甲師団（双戦車 + 重装歩兵）---
            {
                duration: 35, spawnInterval: 1.0, maxSimultaneous: 17,
                pool: [
                    { type: 'infantry', subType: 'rifle',        weight: 1 },
                    { type: 'infantry', subType: 'grenade',      weight: 1 },
                    { type: 'infantry', subType: 'shield',       weight: 1 },
                    { type: 'infantry', subType: 'flamethrower', weight: 1 },
                    { type: 'infantry', subType: 'officer',      weight: 1 },
                    { type: 'infantry', subType: 'juggernaut',   weight: 1 },
                    { type: 'tank',     subType: 'light',        weight: 2 },
                    { type: 'tank',     subType: 'heavy',        weight: 2 },
                    { type: 'aircraft', subType: 'scout_heli',   weight: 1 },
                ],
            },
            // --- Wave 12: 精鋭乱戦 + 最終ボス Tani Oh 強化版 ---
            {
                duration: 50, spawnInterval: 0.95, maxSimultaneous: 16,
                pool: [
                    { type: 'infantry', subType: 'machinegun',   weight: 1 },
                    { type: 'infantry', subType: 'rocket',       weight: 1 },
                    { type: 'infantry', subType: 'sniper',       weight: 1 },
                    { type: 'infantry', subType: 'ninja',        weight: 1 },
                    { type: 'infantry', subType: 'mummy',        weight: 1 },
                    { type: 'infantry', subType: 'flamethrower', weight: 1 },
                    { type: 'infantry', subType: 'officer',      weight: 1 },
                    { type: 'infantry', subType: 'juggernaut',   weight: 1 },
                    { type: 'tank',     subType: 'heavy',        weight: 1 },
                ],
            },
            // --- Wave 13: 焦土進軍（重装歩兵の先鋒 + 屋上スナイパー）---
            {
                duration: 36, spawnInterval: 0.95, maxSimultaneous: 18,
                pool: [
                    { type: 'infantry', subType: 'juggernaut',     weight: 2 },
                    { type: 'infantry', subType: 'shield',         weight: 2 },
                    { type: 'infantry', subType: 'machinegun',     weight: 2 },
                    { type: 'infantry', subType: 'rocket',         weight: 2 },
                    { type: 'infantry', subType: 'perched_sniper', weight: 2 },
                    { type: 'tank',     subType: 'heavy',          weight: 2 },
                    { type: 'aircraft', subType: 'attack_heli',    weight: 1 },
                ],
            },
            // --- Wave 14: 砂嵐制圧線（空地同時圧力）---
            {
                duration: 38, spawnInterval: 0.92, maxSimultaneous: 19,
                pool: [
                    { type: 'infantry', subType: 'juggernaut',   weight: 2 },
                    { type: 'infantry', subType: 'ninja',        weight: 2 },
                    { type: 'infantry', subType: 'sniper',       weight: 2 },
                    { type: 'tank',     subType: 'light',        weight: 2 },
                    { type: 'tank',     subType: 'heavy',        weight: 2 },
                    { type: 'aircraft', subType: 'bomber',       weight: 2 },
                    { type: 'aircraft', subType: 'fighter',      weight: 1 },
                ],
            },
            // --- Wave 15: 鉄血混成旅団（精鋭歩兵ラッシュ）---
            {
                duration: 40, spawnInterval: 0.88, maxSimultaneous: 20,
                pool: [
                    { type: 'infantry', subType: 'juggernaut',   weight: 3 },
                    { type: 'infantry', subType: 'officer',      weight: 2 },
                    { type: 'infantry', subType: 'flamethrower', weight: 2 },
                    { type: 'infantry', subType: 'machinegun',   weight: 2 },
                    { type: 'infantry', subType: 'hunter',       weight: 2 },
                    { type: 'tank',     subType: 'heavy',        weight: 2 },
                ],
            },
            // --- Wave 16: 要塞突破戦（超強化ボス戦前哨）---
            {
                duration: 45, spawnInterval: 0.85, maxSimultaneous: 19,
                pool: [
                    { type: 'infantry', subType: 'juggernaut',     weight: 3 },
                    { type: 'infantry', subType: 'shield',         weight: 2 },
                    { type: 'infantry', subType: 'rocket',         weight: 2 },
                    { type: 'infantry', subType: 'sniper',         weight: 1 },
                    { type: 'infantry', subType: 'perched_sniper', weight: 2 },
                    { type: 'tank',     subType: 'heavy',          weight: 2 },
                    { type: 'aircraft', subType: 'attack_heli',    weight: 2 },
                ],
            },
            // --- Wave 17: 終末連隊（ボス後の殲滅フェーズ）---
            {
                duration: 42, spawnInterval: 0.8, maxSimultaneous: 21,
                pool: [
                    { type: 'infantry', subType: 'juggernaut',   weight: 3 },
                    { type: 'infantry', subType: 'ninja',        weight: 2 },
                    { type: 'infantry', subType: 'mummy',        weight: 2 },
                    { type: 'infantry', subType: 'officer',      weight: 2 },
                    { type: 'tank',     subType: 'heavy',        weight: 2 },
                    { type: 'aircraft', subType: 'bomber',       weight: 2 },
                    { type: 'aircraft', subType: 'fighter',      weight: 2 },
                ],
            },
            // --- Wave 18: 装甲遊撃隊（新精鋭兵の投入）---
            {
                duration: 44, spawnInterval: 0.78, maxSimultaneous: 22,
                pool: [
                    { type: 'infantry', subType: 'commando',     weight: 3 },
                    { type: 'infantry', subType: 'juggernaut',   weight: 2 },
                    { type: 'infantry', subType: 'ninja',        weight: 2 },
                    { type: 'infantry', subType: 'sniper',       weight: 1 },
                    { type: 'tank',     subType: 'heavy',        weight: 2 },
                    { type: 'tank',     subType: 'flak',         weight: 1 },
                    { type: 'aircraft', subType: 'interceptor',  weight: 1 },
                ],
            },
            // --- Wave 19: 工兵火線（爆破兵とドローンの面制圧）---
            {
                duration: 46, spawnInterval: 0.74, maxSimultaneous: 23,
                pool: [
                    { type: 'infantry', subType: 'demolition',   weight: 3 },
                    { type: 'infantry', subType: 'commando',     weight: 2 },
                    { type: 'infantry', subType: 'rocket',       weight: 2 },
                    { type: 'infantry', subType: 'flamethrower', weight: 2 },
                    { type: 'tank',     subType: 'flak',         weight: 2 },
                    { type: 'aircraft', subType: 'drone',        weight: 3 },
                    { type: 'aircraft', subType: 'fighter',      weight: 1 },
                ],
            },
            // --- Wave 20: 空中機動要塞（ガンシップ初登場）---
            {
                duration: 48, spawnInterval: 0.72, maxSimultaneous: 22,
                pool: [
                    { type: 'infantry', subType: 'commando',     weight: 2 },
                    { type: 'infantry', subType: 'demolition',   weight: 2 },
                    { type: 'infantry', subType: 'juggernaut',   weight: 2 },
                    { type: 'tank',     subType: 'siege',        weight: 1 },
                    { type: 'aircraft', subType: 'gunship',      weight: 3 },
                    { type: 'aircraft', subType: 'interceptor',  weight: 2 },
                    { type: 'aircraft', subType: 'drone',        weight: 2 },
                ],
            },
            // --- Wave 21: 超重包囲網（地上重機と空襲の同時圧力）---
            {
                duration: 50, spawnInterval: 0.68, maxSimultaneous: 24,
                pool: [
                    { type: 'infantry', subType: 'commando',     weight: 3 },
                    { type: 'infantry', subType: 'demolition',   weight: 3 },
                    { type: 'infantry', subType: 'officer',      weight: 2 },
                    { type: 'infantry', subType: 'juggernaut',   weight: 3 },
                    { type: 'tank',     subType: 'flak',         weight: 2 },
                    { type: 'tank',     subType: 'siege',        weight: 2 },
                    { type: 'aircraft', subType: 'gunship',      weight: 2 },
                    { type: 'aircraft', subType: 'interceptor',  weight: 2 },
                ],
            },
            // --- Wave 22: 最終防衛線（新敵種ほぼ全投入 + 屋上狙撃手強化）---
            {
                duration: 55, spawnInterval: 0.64, maxSimultaneous: 26,
                pool: [
                    { type: 'infantry', subType: 'commando',       weight: 3 },
                    { type: 'infantry', subType: 'demolition',     weight: 3 },
                    { type: 'infantry', subType: 'juggernaut',     weight: 3 },
                    { type: 'infantry', subType: 'ninja',          weight: 2 },
                    { type: 'infantry', subType: 'sniper',         weight: 2 },
                    { type: 'infantry', subType: 'perched_sniper', weight: 3 },
                    { type: 'tank',     subType: 'heavy',          weight: 2 },
                    { type: 'tank',     subType: 'flak',           weight: 2 },
                    { type: 'tank',     subType: 'siege',          weight: 2 },
                    { type: 'aircraft', subType: 'gunship',        weight: 2 },
                    { type: 'aircraft', subType: 'interceptor',    weight: 2 },
                    { type: 'aircraft', subType: 'drone',          weight: 2 },
                    { type: 'aircraft', subType: 'bomber',         weight: 1 },
                ],
            },
            // --- Wave 23: 無限地獄（全敵種ランダム）---
            {
                duration: 999, spawnInterval: 0.6, maxSimultaneous: 26,
                pool: [
                    { type: 'infantry', subType: 'rifle',        weight: 1 },
                    { type: 'infantry', subType: 'knife',        weight: 1 },
                    { type: 'infantry', subType: 'rocket',       weight: 1 },
                    { type: 'infantry', subType: 'grenade',      weight: 1 },
                    { type: 'infantry', subType: 'machinegun',   weight: 1 },
                    { type: 'infantry', subType: 'officer',      weight: 1 },
                    { type: 'infantry', subType: 'shield',       weight: 1 },
                    { type: 'infantry', subType: 'flamethrower', weight: 1 },
                    { type: 'infantry', subType: 'mummy',        weight: 1 },
                    { type: 'infantry', subType: 'sniper',       weight: 1 },
                    { type: 'infantry', subType: 'hunter',       weight: 1 },
                    { type: 'infantry', subType: 'ninja',        weight: 1 },
                    { type: 'infantry', subType: 'juggernaut',   weight: 1 },
                    { type: 'infantry', subType: 'commando',     weight: 2 },
                    { type: 'infantry', subType: 'demolition',   weight: 2 },
                    { type: 'infantry', subType: 'perched_sniper', weight: 2 },
                    { type: 'tank',     subType: 'light',        weight: 1 },
                    { type: 'tank',     subType: 'heavy',        weight: 1 },
                    { type: 'tank',     subType: 'flak',         weight: 1 },
                    { type: 'tank',     subType: 'siege',        weight: 1 },
                    { type: 'aircraft', subType: 'scout_heli',   weight: 1 },
                    { type: 'aircraft', subType: 'attack_heli',  weight: 1 },
                    { type: 'aircraft', subType: 'bomber',       weight: 1 },
                    { type: 'aircraft', subType: 'fighter',      weight: 1 },
                    { type: 'aircraft', subType: 'drone',        weight: 2 },
                    { type: 'aircraft', subType: 'interceptor',  weight: 2 },
                    { type: 'aircraft', subType: 'gunship',      weight: 1 },
                ],
            },
        ];

        this.waveElapsed = 0;
    }

    update(dt, player, elapsedTime) {
        if (this.gameOver) return;

        this.elapsedTime = elapsedTime;
        this.waveElapsed += dt;

        const playerPos = player.getPosition();
        const scrollZ = this.getScrollZ();

        // ウェーブ進行
        const wave = this.waves[Math.min(this.waveIndex, this.waves.length - 1)];
        if (this.waveElapsed > wave.duration && this.waveIndex < this.waves.length - 1) {
            this.waveIndex++;
            this.waveElapsed = 0;
            this.enemiesSpawnedInWave = 0;
            if (this.onWaveChange) this.onWaveChange(this.waveIndex + 1);
        }

        // スポーン
        this.spawnTimer += dt;
        const activeEnemies = this.enemies.filter(e => e.alive).length;
        if (this.spawnTimer >= wave.spawnInterval && activeEnemies < wave.maxSimultaneous) {
            this.spawnTimer = 0;
            this._spawnFromPool(wave.pool, playerPos, scrollZ);
        }

        // 全敵更新
        this.enemies.forEach(enemy => {
            if (enemy.alive) {
                enemy.update(dt, playerPos, elapsedTime);
            }
        });

        // ボス更新
        if (this.boss && this.boss.alive) {
            this.boss.update(dt, playerPos);
        }

        // ボススポーン（Wave 4/8/12/16/20）
        const waveNum = this.waveIndex + 1;
        if ((waveNum === 4 || waveNum === 8 || waveNum === 12 || waveNum === 16 || waveNum === 20) && !this.bossSpawnedWaves.has(waveNum)) {
            if (this.waveElapsed > 5 && !this.boss) {
                this._spawnBoss(waveNum, scrollZ);
                this.bossSpawnedWaves.add(waveNum);
            }
        }

        // POW スポーン (Feature 1)
        this.powSpawnTimer += dt;
        if (this.powSpawnTimer > this.powSpawnInterval && this.pows.length < 2) {
            this._spawnPOW(scrollZ);
            this.powSpawnTimer = 0;
        }

        // POW 更新
        for (let i = this.pows.length - 1; i >= 0; i--) {
            const pow = this.pows[i];
            pow.update(dt, playerPos);

            if (pow.state === 'tied') {
                const d = pow.group.position.distanceTo(playerPos);
                if (d < 2.5) {
                    pow.release();
                    if (this.onPowRescued) this.onPowRescued(pow.reward);
                }
            }

            if (pow.pendingReward) {
                const dropPos = pow.group.position.clone();
                this.items.push(new ItemDrop(this.scene, dropPos, pow.pendingReward));
                pow.pendingReward = null;
            }

            if (!pow.alive) {
                pow.destroy();
                this.pows.splice(i, 1);
            }
        }

        // 衝突判定
        this._checkCollisions(player);

        // エフェクト更新
        this.effects.forEach(e => e.update(dt));
        // alive=false になったエフェクトは確実に destroy してから除去
        this.effects.forEach(e => {
            if (!e.alive && e.destroy) e.destroy();
        });
        this.effects = this.effects.filter(e => e.alive);

        // 画面外の敵を削除（スクロール後方に大きく離れた敵）
        this.enemies.forEach(enemy => {
            if (enemy.alive) {
                const ez = enemy.getPosition().z;
                if (ez < scrollZ - 25) {
                    enemy.takeDamage(9999);
                }
            }
        });

        // クリーンアップ（ランダムではなく周期実行）
        this.cleanupTimer += dt;
        if (this.cleanupTimer >= 0.5) {
            this.cleanupTimer = 0;
            this._cleanup();
        }
    }

    // ============================================
    // 衝突判定
    // ============================================
    _checkCollisions(player) {
        // プレイヤー弾 × POW 誤射判定 (Feature 1)
        this.pows.forEach(pow => {
            if (!pow.alive || pow.state !== 'tied') return;
            player.projectiles.forEach(p => {
                if (!p.alive) return;
                const pPos = p.getPosition ? p.getPosition() : p.group.position;
                if (pPos.distanceTo(pow.group.position) < 0.9) {
                    pow.takeDamage(10);
                    p.alive = false;
                }
            });
        });

        this._handlePlayerProjectiles(player);
        this._handlePlayerProjectilesVsWorld(player);
        this._handleEnemyProjectiles(player);

        if (player.isInvincible()) return;

        const playerPos = player.getPosition();

        for (const enemy of this.enemies) {
            if (!enemy.alive || enemy.subType !== 'knife') continue;

            const enemyPos = enemy.getPosition();
            const dx = enemyPos.x - playerPos.x;
            const dz = enemyPos.z - playerPos.z;
            const distSq = dx * dx + dz * dz;

            if (distSq < 2.0 * 2.0) {
                this._damagePlayer(player, enemy.damage, enemyPos);
                enemy.takeDamage(999);
                this._spawnExplosion(enemyPos, 'small');
            }
        }
    }

    _handlePlayerProjectiles(player) {
        const playerPos = player.getPosition();

        for (const projectile of player.projectiles) {
            if (!projectile.alive || projectile.impactPending) continue;

            const hit = this._findClosestHostileHit(projectile);
            if (!hit) continue;

            if ((projectile.blastRadius || 0) > 0) {
                this._explodePlayerProjectile(projectile, hit.point, playerPos, hit);
            } else {
                if (hit.kind === 'boss') {
                    this._damageBoss(projectile.damage);
                } else {
                    this._damageEnemyFromPlayer(hit.target, projectile.damage, projectile, playerPos);
                }
                this._spawnHitSpark(hit.point.clone());
                if (this.soundManager) this.soundManager.playEnemyHit();
                projectile.destroy();
            }
        }

        for (const projectile of player.projectiles) {
            if (!projectile.impactPending) continue;
            this._explodePlayerProjectile(
                projectile,
                projectile.impactPosition ? projectile.impactPosition.clone() : projectile.getPosition(),
                playerPos
            );
        }
    }

    _handlePlayerProjectilesVsWorld(player) {
        if (!this.world || typeof this.world.getObstacles !== 'function') return;
        const obstacles = this.world.getObstacles();
        if (!obstacles.length) return;

        for (const projectile of player.projectiles) {
            if (!projectile.alive || projectile.impactPending) continue;

            const { start, end } = this._getProjectileSegment(projectile);
            const projRadius = projectile.hitRadius || 0.2;

            // 最近接で当たった障害物を選ぶ
            let bestHit = null;
            for (const o of obstacles) {
                if (o.info.destroyed) continue;
                const center = new THREE.Vector3(o.obj.position.x, 0.9, o.obj.position.z);
                const hit = this._segmentSphereHit(start, end, center, o.info.radius + projRadius);
                if (hit && (!bestHit || hit.t < bestHit.t)) {
                    bestHit = { ...hit, target: o };
                }
            }
            if (!bestHit) continue;

            const o = bestHit.target;
            const isBlock = o.info.type === 'block';

            if (isBlock) {
                // 大型建造物は弾を止めるだけ（破壊不可）
                if ((projectile.blastRadius || 0) > 0) {
                    this._explodePlayerProjectile(projectile, bestHit.point, player.getPosition(), null);
                } else {
                    this._spawnHitSpark(bestHit.point.clone());
                    if (this.soundManager && this.soundManager.playEnemyHit) this.soundManager.playEnemyHit();
                    projectile.destroy();
                }
                continue;
            }

            // destructible: HP を減らす
            o.info.hp -= projectile.damage;
            if (o.info.hp <= 0) {
                this._destroyWorldObstacle(o, bestHit.point, projectile, player);
            } else {
                this._spawnHitSpark(bestHit.point.clone());
                if (this.soundManager && this.soundManager.playEnemyHit) this.soundManager.playEnemyHit();
            }

            // 砲弾の処理（爆風弾は爆発、通常弾は消える）
            if ((projectile.blastRadius || 0) > 0) {
                this._explodePlayerProjectile(projectile, bestHit.point, player.getPosition(), null);
            } else {
                projectile.destroy();
            }
        }
    }

    _destroyWorldObstacle(o, hitPoint, projectile, player) {
        const info = o.info;
        const obj = o.obj;
        const pos = new THREE.Vector3(obj.position.x, 0.5, obj.position.z);

        // 爆発演出
        const visual = info.explosionVisual || (info.explosive ? 'large' : 'small');
        this._spawnExplosion(pos, visual);
        if (this.onScreenShake) this.onScreenShake(info.explosive ? 0.45 : 0.18);

        if (this.soundManager) {
            if (info.explosive && this.soundManager.playExplosionLarge) this.soundManager.playExplosionLarge();
            else if (this.soundManager.playExplosionSmall) this.soundManager.playExplosionSmall();
        }

        // 連鎖爆発（オイルドラム等）: 敵にスプラッシュダメージ
        if (info.explosive && info.blastRadius > 0) {
            const playerPos = player ? player.getPosition() : pos;
            for (const enemy of this.enemies) {
                if (!enemy.alive) continue;
                const d = enemy.getPosition().distanceTo(pos);
                if (d < info.blastRadius) {
                    const dmg = Math.max(20, Math.floor(110 * (1 - d / info.blastRadius)));
                    this._damageEnemyFromPlayer(enemy, dmg, projectile, playerPos);
                }
            }
            if (this.boss && this.boss.alive) {
                const d = this.boss.getPosition().distanceTo(pos);
                if (d < info.blastRadius * 1.5) {
                    this._damageBoss(Math.floor(60 * (1 - d / (info.blastRadius * 1.5))));
                }
            }
        }

        // スコア
        if (info.score && this.onScoreChange) {
            this.score += info.score;
            this.onScoreChange(this.score);
        }

        // アイテムドロップ
        if (info.dropChance > 0 && info.dropTable && Math.random() < info.dropChance) {
            const choice = info.dropTable[Math.floor(Math.random() * info.dropTable.length)];
            const dropPos = new THREE.Vector3(obj.position.x, 0, obj.position.z);
            this.items.push(new ItemDrop(this.scene, dropPos, choice));
        }

        // ワールドから除去
        this.world.destroyObstacle(obj);
    }

    _handleEnemyProjectiles(player) {
        const hostileProjectiles = this.getAllEnemyProjectiles();

        for (const projectile of hostileProjectiles) {
            if (!projectile.alive || projectile.impactPending || player.isInvincible()) continue;

            const hit = this._findPlayerHit(projectile, player);
            if (!hit) continue;

            if ((projectile.blastRadius || 0) > 0) {
                this._explodeEnemyProjectile(projectile, hit.point, player, true);
            } else {
                projectile.destroy();
                this._damagePlayer(player, projectile.damage, hit.point);
            }
        }

        for (const projectile of hostileProjectiles) {
            if (!projectile.impactPending) continue;
            this._explodeEnemyProjectile(
                projectile,
                projectile.impactPosition ? projectile.impactPosition.clone() : projectile.getPosition(),
                player,
                false
            );
        }
    }

    _findClosestHostileHit(projectile) {
        const { start, end } = this._getProjectileSegment(projectile);
        const projectileRadius = projectile.hitRadius || 0.2;
        let bestHit = null;

        for (const enemy of this.enemies) {
            if (!enemy.alive) continue;
            const hit = this._findClosestHitAgainstSpheres(
                start,
                end,
                projectileRadius,
                this._getHitSpheresForEnemy(enemy)
            );
            if (hit && (!bestHit || hit.t < bestHit.t)) {
                bestHit = { ...hit, kind: 'enemy', target: enemy };
            }
        }

        if (this.boss && this.boss.alive) {
            const hit = this._findClosestHitAgainstSpheres(
                start,
                end,
                projectileRadius,
                this._getHitSpheresForBoss(this.boss)
            );
            if (hit && (!bestHit || hit.t < bestHit.t)) {
                bestHit = { ...hit, kind: 'boss', target: this.boss };
            }
        }

        return bestHit;
    }

    _findPlayerHit(projectile, player) {
        const { start, end } = this._getProjectileSegment(projectile);
        return this._findClosestHitAgainstSpheres(
            start,
            end,
            projectile.hitRadius || 0.2,
            this._getHitSpheresForPlayer(player)
        );
    }

    _getProjectileSegment(projectile) {
        const currentPos = projectile.getPosition ? projectile.getPosition() : projectile.group.position;
        const end = currentPos.clone ? currentPos.clone() : new THREE.Vector3(currentPos.x, currentPos.y, currentPos.z);
        const start = projectile.previousPosition ? projectile.previousPosition.clone() : end.clone();
        return { start, end };
    }

    _findClosestHitAgainstSpheres(start, end, projectileRadius, spheres) {
        let bestHit = null;

        for (const sphere of spheres) {
            const hit = this._segmentSphereHit(start, end, sphere.center, sphere.radius + projectileRadius);
            if (hit && (!bestHit || hit.t < bestHit.t)) {
                bestHit = hit;
            }
        }

        return bestHit;
    }

    _segmentSphereHit(start, end, center, radius) {
        // 共有テンポラリ: この関数の内部でしか使わない。戻り値の point だけ新規確保する
        // （上位で bestHit として保持されるので使い回せない）。
        const segment = _hitTmpSeg.subVectors(end, start);
        const segLenSq = segment.lengthSq();
        if (segLenSq < 0.0001) {
            const distSq = start.distanceToSquared(center);
            return distSq <= radius * radius ? { t: 0, point: start.clone() } : null;
        }

        const t = THREE.MathUtils.clamp(
            _hitTmpDelta.subVectors(center, start).dot(segment) / segLenSq,
            0,
            1
        );
        const point = start.clone().addScaledVector(segment, t);
        return point.distanceToSquared(center) <= radius * radius ? { t, point } : null;
    }

    /**
     * entity._hitSphereCache を `count` 個に揃え、center は再利用する。
     * 戻り値は同じ配列を返すので呼び出し側で center.set / radius を上書きする。
     */
    _ensureSphereCache(entity, count) {
        let arr = entity._hitSphereCache;
        if (!arr) {
            arr = entity._hitSphereCache = [];
        }
        while (arr.length < count) {
            arr.push({ center: new THREE.Vector3(), radius: 0 });
        }
        if (arr.length > count) arr.length = count;
        return arr;
    }

    /** center.set(x,y,z) → quaternion 適用 → ワールド座標 pos を加算（in-place） */
    _setSphereCenter(sphere, x, y, z, q, pos) {
        sphere.center.set(x, y, z);
        if (q) sphere.center.applyQuaternion(q);
        sphere.center.add(pos);
    }

    _getHitSpheresForEnemy(enemy) {
        const pos = enemy.getPosition();
        const q = enemy.group ? enemy.group.quaternion : null;

        switch (enemy.type) {
            case 'tank': {
                const scale = enemy.subType === 'siege' ? 1.62 : (enemy.subType === 'heavy' ? 1.35 : (enemy.subType === 'flak' ? 1.18 : 1.0));
                const hasTurret = !!enemy.turretGroup;
                const arr = this._ensureSphereCache(enemy, hasTurret ? 4 : 3);
                this._setSphereCenter(arr[0], 0, 1.05 * scale, 0, q, pos); arr[0].radius = 1.55 * scale;
                this._setSphereCenter(arr[1], -1.15 * scale, 0.75 * scale, 0, q, pos); arr[1].radius = 0.95 * scale;
                this._setSphereCenter(arr[2], 1.15 * scale, 0.85 * scale, 0, q, pos); arr[2].radius = 0.95 * scale;
                if (hasTurret) {
                    enemy.turretGroup.getWorldPosition(arr[3].center);
                    arr[3].radius = 1.0 * scale;
                }
                return arr;
            }
            case 'aircraft': {
                const baseRadius = enemy.subType === 'gunship' ? 2.1
                    : (enemy.subType === 'bomber' ? 1.7
                    : (enemy.subType === 'attack_heli' ? 1.45
                    : (enemy.subType === 'interceptor' ? 1.35
                    : (enemy.subType === 'drone' ? 0.85 : 1.2))));
                const arr = this._ensureSphereCache(enemy, 2);
                arr[0].center.copy(pos); arr[0].radius = baseRadius;
                this._setSphereCenter(arr[1], -1.5, 0, 0, q, pos); arr[1].radius = baseRadius * 0.55;
                return arr;
            }
            case 'infantry':
            default: {
                const arr = this._ensureSphereCache(enemy, 2);
                arr[0].center.copy(pos); arr[0].center.y += 1.25; arr[0].radius = 0.48;
                arr[1].center.copy(pos); arr[1].center.y += 0.7;  arr[1].radius = 0.42;
                return arr;
            }
        }
    }

    _getHitSpheresForBoss(boss) {
        const pos = boss.getPosition();
        const q = boss.group ? boss.group.quaternion : null;

        if (boss.subType === 'tani_oh') {
            const arr = this._ensureSphereCache(boss, 3);
            this._setSphereCenter(arr[0], 0, 0.2, 0, q, pos);    arr[0].radius = 4.8;
            this._setSphereCenter(arr[1], 2.2, 1.2, 0, q, pos);  arr[1].radius = 2.2;
            this._setSphereCenter(arr[2], -2.6, -0.4, 0, q, pos);arr[2].radius = 2.4;
            return arr;
        }

        const hasTurret = !!boss.turretGroup;
        const arr = this._ensureSphereCache(boss, hasTurret ? 4 : 3);
        this._setSphereCenter(arr[0], 0, 2.1, 0, q, pos);   arr[0].radius = 3.2;
        this._setSphereCenter(arr[1], 2.8, 2.0, 0, q, pos); arr[1].radius = 1.8;
        this._setSphereCenter(arr[2], -2.4, 1.6, 0, q, pos);arr[2].radius = 1.7;
        if (hasTurret) {
            boss.turretGroup.getWorldPosition(arr[3].center);
            arr[3].radius = 1.9;
        }
        return arr;
    }

    _getHitSpheresForPlayer(player) {
        const pos = player.getPosition();
        // visualGroup はモデルローカル +X → ワールド +Z（前方）になるよう回転されている。
        // ローカル前後オフセットをワールドへ変換する。
        const q = player.visualGroup ? player.visualGroup.quaternion : null;
        const hasTurret = !!player.turretGroup;
        const arr = this._ensureSphereCache(player, hasTurret ? 4 : 3);
        this._setSphereCenter(arr[0], 0, 1.0, 0, q, pos);     arr[0].radius = 1.25;
        this._setSphereCenter(arr[1], -0.95, 0.8, 0, q, pos); arr[1].radius = 0.72;
        this._setSphereCenter(arr[2], 1.1, 0.85, 0, q, pos);  arr[2].radius = 0.8;
        if (hasTurret) {
            player.turretGroup.getWorldPosition(arr[3].center);
            arr[3].radius = 0.95;
        }
        return arr;
    }

    _getExplosionExposure(spheres, position, blastRadius) {
        let best = 0;

        for (const sphere of spheres) {
            const effectiveRadius = blastRadius + sphere.radius;
            const dist = position.distanceTo(sphere.center);
            if (dist <= effectiveRadius) {
                best = Math.max(best, 1 - dist / effectiveRadius);
            }
        }

        return best;
    }

    _damageEnemyFromPlayer(enemy, damage, projectile, playerPos) {
        if (!enemy.alive) return;

        let appliedDamage = damage;
        if (enemy.subType === 'shield') {
            const enemyPos = enemy.getPosition();
            const toEnemy = new THREE.Vector3().subVectors(enemyPos, playerPos).normalize();
            const projectileDir = projectile.velocity
                ? projectile.velocity.clone().normalize()
                : toEnemy.clone();
            if (toEnemy.dot(projectileDir) > 0.25) {
                appliedDamage = Math.max(1, Math.floor(damage * 0.45));
            }
        }

        enemy.takeDamage(appliedDamage);
        if (!enemy.alive) {
            this._onEnemyKilled(enemy);
        }
    }

    _damageBoss(damage) {
        if (!this.boss || !this.boss.alive) return;

        this.boss.takeDamage(damage);
        if (this.onBossHpChange) {
            this.onBossHpChange(this.boss.hp, this.boss.maxHp);
        }

        if (!this.boss.alive) {
            this.score += this.boss.scoreValue;
            this.kills++;
            if (this.onScreenShake) this.onScreenShake(1.5);
            if (this.soundManager) this.soundManager.playExplosionLarge();
            // effects に登録して update/cleanup の対象にする
            this.boss.destroy(this.effects);
            this.boss = null;
            if (this.onBossDefeated) this.onBossDefeated();
        }
    }

    _damagePlayer(player, damage, impactPosition) {
        if (player.isInvincible()) return;

        player.takeDamage(damage);
        if (this.onPlayerHit) this.onPlayerHit(player.hp, player.maxHp);
        if (player.hp <= 0 && !this.gameOver) {
            this._triggerGameOver(player);
        }

        if (impactPosition) {
            this._spawnHitSpark(impactPosition.clone());
        }
    }

    _explodePlayerProjectile(projectile, impactPosition, playerPos, directHit = null) {
        const impact = impactPosition.clone();
        impact.y = Math.max(impact.y, 0.15);

        this._spawnExplosion(impact, projectile.explosionVisual || 'large');
        if (this.soundManager) this.soundManager.playExplosionLarge();
        if (this.onScreenShake) this.onScreenShake(Math.min(1.0, 0.16 + (projectile.blastRadius || 0) * 0.09));

        if (directHit) {
            if (directHit.kind === 'boss') {
                this._damageBoss(projectile.damage);
            } else {
                this._damageEnemyFromPlayer(directHit.target, projectile.damage, projectile, playerPos);
            }
        }

        for (const enemy of this.enemies) {
            if (!enemy.alive || enemy === directHit?.target) continue;
            const exposure = this._getExplosionExposure(
                this._getHitSpheresForEnemy(enemy),
                impact,
                projectile.blastRadius || 0
            );
            if (exposure <= 0) continue;

            const splashDamage = Math.max(6, Math.round(projectile.damage * exposure * 0.75));
            this._damageEnemyFromPlayer(enemy, splashDamage, projectile, playerPos);
        }

        if (this.boss && this.boss.alive && directHit?.kind !== 'boss') {
            const exposure = this._getExplosionExposure(
                this._getHitSpheresForBoss(this.boss),
                impact,
                projectile.blastRadius || 0
            );
            if (exposure > 0) {
                const splashDamage = Math.max(10, Math.round(projectile.damage * exposure * 0.55));
                this._damageBoss(splashDamage);
            }
        }

        projectile.destroy();
    }

    _explodeEnemyProjectile(projectile, impactPosition, player, directHitPlayer = false) {
        const impact = impactPosition.clone();
        impact.y = Math.max(impact.y, 0.15);

        this._spawnExplosion(impact, projectile.explosionVisual || 'large');
        if (this.soundManager) this.soundManager.playExplosionLarge();
        if (this.onScreenShake) this.onScreenShake(Math.min(1.2, 0.18 + (projectile.blastRadius || 0) * 0.11));

        if (!player.isInvincible()) {
            const exposure = directHitPlayer
                ? 1
                : this._getExplosionExposure(
                    this._getHitSpheresForPlayer(player),
                    impact,
                    projectile.blastRadius || 0
                );

            if (exposure > 0) {
                const damage = directHitPlayer
                    ? projectile.damage
                    : Math.max(4, Math.round(projectile.damage * (0.35 + exposure * 0.65)));
                this._damagePlayer(player, damage, impact);
            }
        }

        projectile.destroy();
    }

    // ============================================
    // 撃破処理
    // ============================================
    _onEnemyKilled(enemy) {
        this.kills++;

        let finalScore = enemy.scoreValue;
        if (this.onEnemyKilled) {
            finalScore = this.onEnemyKilled(enemy);
        }

        this.score += finalScore;
        if (this.onScoreChange) this.onScoreChange(this.score);

        const pos = enemy.getPosition().clone();

        if (enemy.type === 'infantry') {
            // Metal Slug 特有の「吹き飛び」演出
            pos.y += 0.7;
            this._spawnExplosion(pos, 'small');
            this._spawnInfantryRagdoll(enemy);
            if (this.onScreenShake) this.onScreenShake(0.18);
            if (this.soundManager) this.soundManager.playExplosionSmall();
        } else if (enemy.type === 'tank') {
            // 戦車: 多段爆発 + 破片散乱
            pos.y += 1.5;
            this._spawnExplosion(pos, 'large');
            this._spawnVehicleDebris(pos.clone(), 6);
            if (this.onScreenShake) this.onScreenShake(0.6);
            if (this.soundManager) this.soundManager.playExplosionLarge();
            // 遅延二次爆発
            setTimeout(() => {
                const pos2 = pos.clone().add(new THREE.Vector3(
                    (Math.random() - 0.5) * 2,
                    Math.random() * 1.5,
                    (Math.random() - 0.5) * 2
                ));
                this._spawnExplosion(pos2, 'large');
                if (this.onScreenShake) this.onScreenShake(0.35);
            }, 250);
        } else if (enemy.type === 'aircraft') {
            // 航空機: 煙を吹いて落下するエフェクト
            pos.y += 1.5;
            this._spawnExplosion(pos, 'large');
            this._spawnAircraftCrash(pos.clone());
            if (this.onScreenShake) this.onScreenShake(0.5);
            if (this.soundManager) this.soundManager.playExplosionLarge();
        } else {
            pos.y += 1.5;
            this._spawnExplosion(pos, 'large');
            if (this.onScreenShake) this.onScreenShake(0.4);
        }

        // アイテムドロップ（30%の確率）
        if (Math.random() < 0.3) {
            // 戦車・航空機など強敵はパワーアップ含む豪華テーブル
            const isHeavy = enemy.constructor && /Tank|Aircraft|Boss/.test(enemy.constructor.name || '');
            const dropTypes = isHeavy
                ? ['health', 'grenade', 'score', 'score_big', 'power_BIG', 'power_SPREAD', 'power_FLAME']
                : ['health', 'grenade', 'score', 'score', 'power_SPREAD'];
            const dropType = dropTypes[Math.floor(Math.random() * dropTypes.length)];
            const dropPos = enemy.getPosition().clone();
            const item = new ItemDrop(this.scene, dropPos, dropType);
            this.items.push(item);
        }
    }

    /**
     * 歩兵ラグドール: 上に吹き飛ばされてスピンしながら落下
     */
    _spawnInfantryRagdoll(enemy) {
        const ragdollGroup = new THREE.Group();
        const startPos = enemy.getPosition().clone();
        ragdollGroup.position.copy(startPos);

        // シンプルなボディパーツ（胴体、両腕、脚）
        const bodyColors = [0x4B5320, 0x556B2F, 0x8B7355];
        const parts = [];

        // 胴体
        const torsoGeo = new THREE.BoxGeometry(0.3, 0.5, 0.25);
        const torsoMat = new THREE.MeshLambertMaterial({ color: bodyColors[0] });
        const torso = new THREE.Mesh(torsoGeo, torsoMat);
        ragdollGroup.add(torso);
        parts.push({ mesh: torso, vx: (Math.random() - 0.5) * 3, vy: 8 + Math.random() * 4, vz: (Math.random() - 0.5) * 3, rx: (Math.random() - 0.5) * 12, rz: (Math.random() - 0.5) * 8 });

        // ヘルメット
        const helmGeo = new THREE.SphereGeometry(0.12, 6, 4);
        const helmMat = new THREE.MeshLambertMaterial({ color: 0x5C5C3D });
        const helm = new THREE.Mesh(helmGeo, helmMat);
        helm.position.set(0, 0.35, 0);
        ragdollGroup.add(helm);
        parts.push({ mesh: helm, vx: (Math.random() - 0.5) * 5, vy: 10 + Math.random() * 3, vz: (Math.random() - 0.5) * 5, rx: (Math.random() - 0.5) * 15, rz: (Math.random() - 0.5) * 15 });

        // 腕パーツ x2
        for (let side = -1; side <= 1; side += 2) {
            const armGeo = new THREE.BoxGeometry(0.1, 0.35, 0.1);
            const armMat = new THREE.MeshLambertMaterial({ color: bodyColors[1] });
            const arm = new THREE.Mesh(armGeo, armMat);
            arm.position.set(side * 0.25, 0.1, 0);
            ragdollGroup.add(arm);
            parts.push({ mesh: arm, vx: side * (2 + Math.random() * 3), vy: 7 + Math.random() * 5, vz: (Math.random() - 0.5) * 4, rx: (Math.random() - 0.5) * 20, rz: (Math.random() - 0.5) * 20 });
        }

        this.scene.add(ragdollGroup);

        const ragdollEffect = {
            alive: true, age: 0, maxAge: 1.2,
            group: ragdollGroup, parts,
            update(dt) {
                this.age += dt;
                if (this.age >= this.maxAge) { this.alive = false; return; }
                const progress = this.age / this.maxAge;
                this.parts.forEach(p => {
                    p.mesh.position.x += p.vx * dt;
                    p.mesh.position.y += p.vy * dt;
                    p.mesh.position.z += p.vz * dt;
                    p.vy -= 15 * dt; // 重力
                    p.mesh.rotation.x += p.rx * dt;
                    p.mesh.rotation.z += p.rz * dt;
                    p.mesh.material.opacity = Math.max(0, 1 - progress * 0.8);
                    p.mesh.material.transparent = true;
                });
            },
        };

        const scene = this.scene;
        let disposed = false;
        const cleanup = () => {
            if (disposed) return;
            disposed = true;
            scene.remove(ragdollGroup);
            ragdollGroup.traverse(child => {
                if (child.isMesh) {
                    if (child.geometry) child.geometry.dispose();
                    if (child.material) child.material.dispose();
                }
            });
        };
        const origUpdate = ragdollEffect.update.bind(ragdollEffect);
        ragdollEffect.update = (dt) => {
            origUpdate(dt);
            if (!ragdollEffect.alive) cleanup();
        };
        // MAX_EFFECTS 溢れで shift された場合でも確実に解放できる destroy を提供
        ragdollEffect.destroy = () => {
            ragdollEffect.alive = false;
            cleanup();
        };

        this.effects.push(ragdollEffect);
    }

    /**
     * 車両破片エフェクト: パーツが散乱して転がる
     */
    _spawnVehicleDebris(position, count) {
        const debrisGroup = new THREE.Group();
        debrisGroup.position.copy(position);

        const debrisColors = [0x3B3B3B, 0x5A5A5A, 0x4B5320, 0x8B7355, 0xFF4400];
        const parts = [];

        for (let i = 0; i < count; i++) {
            const w = 0.15 + Math.random() * 0.35;
            const h = 0.08 + Math.random() * 0.2;
            const d = 0.15 + Math.random() * 0.3;
            const geo = new THREE.BoxGeometry(w, h, d);
            const mat = new THREE.MeshLambertMaterial({
                color: debrisColors[Math.floor(Math.random() * debrisColors.length)],
                transparent: true, opacity: 1.0,
            });
            const piece = new THREE.Mesh(geo, mat);
            debrisGroup.add(piece);

            const angle = Math.random() * Math.PI * 2;
            const upAngle = Math.random() * Math.PI * 0.4;
            const speed = 3 + Math.random() * 8;
            parts.push({
                mesh: piece,
                vx: Math.cos(angle) * Math.sin(upAngle) * speed,
                vy: Math.cos(upAngle) * speed + 2,
                vz: Math.sin(angle) * Math.sin(upAngle) * speed,
                rx: (Math.random() - 0.5) * 14,
                rz: (Math.random() - 0.5) * 14,
                bounce: 0.3 + Math.random() * 0.3,
            });
        }

        this.scene.add(debrisGroup);

        const debrisEffect = {
            alive: true, age: 0, maxAge: 1.8,
            group: debrisGroup, parts,
            update(dt) {
                this.age += dt;
                if (this.age >= this.maxAge) { this.alive = false; return; }
                const progress = this.age / this.maxAge;
                this.parts.forEach(p => {
                    p.mesh.position.x += p.vx * dt;
                    p.mesh.position.y += p.vy * dt;
                    p.mesh.position.z += p.vz * dt;
                    p.vy -= 12 * dt;
                    p.mesh.rotation.x += p.rx * dt;
                    p.mesh.rotation.z += p.rz * dt;
                    // 地面でバウンス
                    if (p.mesh.position.y < 0 && p.vy < 0) {
                        p.mesh.position.y = 0;
                        p.vy *= -p.bounce;
                        p.vx *= 0.6;
                        p.vz *= 0.6;
                        p.bounce *= 0.5;
                    }
                    p.mesh.material.opacity = Math.max(0, 1 - progress);
                });
            },
        };

        const scene = this.scene;
        let debrisDisposed = false;
        debrisEffect.destroy = () => {
            debrisEffect.alive = false;
            if (debrisDisposed) return;
            debrisDisposed = true;
            scene.remove(debrisGroup);
            debrisGroup.traverse(child => {
                if (child.isMesh) {
                    if (child.geometry) child.geometry.dispose();
                    if (child.material) child.material.dispose();
                }
            });
        };

        this.effects.push(debrisEffect);
    }

    /**
     * 航空機墜落エフェクト: 煙を引きながら螺旋落下
     */
    _spawnAircraftCrash(position) {
        const crashAge = { value: 0 };
        const maxAge = 2.0;
        const startPos = position.clone();
        const smokeTrail = [];
        const scene = this.scene;

        const MAX_TRAIL = 32; // 一機あたりの煙トレイル上限
        let crashDisposed = false;
        const crashEffect = {
            alive: true, age: 0, maxAge,
            update(dt) {
                this.age += dt;
                if (this.age >= this.maxAge) { this.alive = false; return; }

                // 煙のトレイルを追加（フレームごと、ただし上限あり）
                if (this.age < 1.5 && Math.random() < 0.7 && smokeTrail.length < MAX_TRAIL) {
                    const t = this.age;
                    const smokeGeo = new THREE.SphereGeometry(0.3 + Math.random() * 0.4, 5, 4);
                    const smokeMat = new THREE.MeshBasicMaterial({
                        color: Math.random() < 0.3 ? 0xFF4400 : 0x333333,
                        transparent: true, opacity: 0.7,
                    });
                    const smoke = new THREE.Mesh(smokeGeo, smokeMat);
                    // 螺旋軌道
                    smoke.position.set(
                        startPos.x + Math.cos(t * 5) * (2 + t * 1.5),
                        Math.max(0.5, startPos.y - t * 6),
                        startPos.z + Math.sin(t * 5) * (2 + t * 1.5)
                    );
                    scene.add(smoke);
                    smokeTrail.push({ mesh: smoke, age: 0 });
                }

                // 煙のフェード & 完全に消えたパフは即解放
                for (let i = smokeTrail.length - 1; i >= 0; i--) {
                    const s = smokeTrail[i];
                    s.age += dt;
                    const op = Math.max(0, 0.7 - s.age * 0.7);
                    s.mesh.material.opacity = op;
                    s.mesh.scale.addScalar(dt * 1.5);
                    if (op <= 0.001) {
                        scene.remove(s.mesh);
                        if (s.mesh.geometry) s.mesh.geometry.dispose();
                        if (s.mesh.material) s.mesh.material.dispose();
                        smokeTrail.splice(i, 1);
                    }
                }
            },
            destroy() {
                this.alive = false;
                if (crashDisposed) return;
                crashDisposed = true;
                smokeTrail.forEach(s => {
                    scene.remove(s.mesh);
                    if (s.mesh.geometry) s.mesh.geometry.dispose();
                    if (s.mesh.material) s.mesh.material.dispose();
                });
                smokeTrail.length = 0;
            },
        };

        this.effects.push(crashEffect);
    }

    // ============================================
    // エフェクト生成
    // ============================================
    _spawnExplosion(position, type) {
        const explosion = new Explosion(this.scene, position, { type });
        this.effects.push(explosion);
    }

    _spawnHitSpark(position) {
        const sparkGroup = new THREE.Group();
        sparkGroup.position.copy(position);

        const particles = [];
        const colors = [0xFFFF00, 0xFFAA00, 0xFFFFFF];
        for (let i = 0; i < 5; i++) {
            const size = 0.04 + Math.random() * 0.06;
            const geo = new THREE.BoxGeometry(size, size, size);
            const mat = new THREE.MeshBasicMaterial({
                color: colors[Math.floor(Math.random() * colors.length)],
                transparent: true, opacity: 1.0,
            });
            const spark = new THREE.Mesh(geo, mat);
            sparkGroup.add(spark);
            particles.push({
                mesh: spark,
                vx: (Math.random() - 0.5) * 8,
                vy: Math.random() * 5 + 2,
                vz: (Math.random() - 0.5) * 8,
            });
        }

        this.scene.add(sparkGroup);

        const sparkEffect = {
            alive: true, age: 0, maxAge: 0.2,
            group: sparkGroup, particles,
            update(dt) {
                this.age += dt;
                if (this.age >= this.maxAge) { this.alive = false; return; }
                const progress = this.age / this.maxAge;
                this.particles.forEach(p => {
                    p.mesh.position.x += p.vx * dt;
                    p.mesh.position.y += p.vy * dt;
                    p.mesh.position.z += p.vz * dt;
                    p.vy -= 20 * dt;
                    p.mesh.material.opacity = 1 - progress;
                });
            },
            destroy() { this.alive = false; },
        };

        const scene = this.scene;
        let sparkDisposed = false;
        const origDestroy = sparkEffect.destroy.bind(sparkEffect);
        sparkEffect.destroy = () => {
            origDestroy();
            if (sparkDisposed) return;
            sparkDisposed = true;
            scene.remove(sparkGroup);
            sparkGroup.traverse(child => {
                if (child.isMesh) {
                    if (child.geometry) child.geometry.dispose();
                    if (child.material) child.material.dispose();
                }
            });
        };

        this.effects.push(sparkEffect);
    }

    // ============================================
    // ゲームオーバー
    // ============================================
    _triggerGameOver(player) {
        this.gameOver = true;
        const pos = player.getPosition().clone();
        pos.y += 1.5;
        this._spawnExplosion(pos, 'large');
        // setTimeout を追跡し、restart で取り消せるようにする。
        // 取り消さないと R 連打時に新ゲーム開始後に古い座標で爆発が湧き出す。
        this._gameOverTimers = this._gameOverTimers || [];
        this._gameOverTimers.push(setTimeout(() => {
            if (this.gameOver) this._spawnExplosion(pos.clone().add(new THREE.Vector3(1, 0.5, -0.5)), 'large');
        }, 200));
        this._gameOverTimers.push(setTimeout(() => {
            if (this.gameOver) this._spawnExplosion(pos.clone().add(new THREE.Vector3(-0.8, 1, 0.3)), 'large');
        }, 400));
        if (this.onGameOver) this.onGameOver(this.score, this.kills, this.getCurrentWave());
    }

    restart() {
        // ゲームオーバー演出の遅延爆発（200ms / 400ms 後）が新ゲームに混入しないよう取消
        if (this._gameOverTimers) {
            this._gameOverTimers.forEach(t => clearTimeout(t));
            this._gameOverTimers = [];
        }
        this.enemies.forEach(e => e.destroy());
        this.enemies = [];
        this.effects.forEach(e => { if (e.destroy) e.destroy(); });
        this.effects = [];
        this.items.forEach(item => { if (item.destroy) item.destroy(); });
        this.items = [];
        this.pows.forEach(p => p.destroy());
        this.pows = [];
        this.powSpawnTimer = 0;
        this.score = 0;
        this.kills = 0;
        this.waveIndex = 0;
        this.waveElapsed = 0;
        this.enemiesSpawnedInWave = 0;
        this.spawnTimer = 0;
        this.gameOver = false;
        if (this.boss) {
            // リセット時は段階爆発カスケードを作らずに即時破棄。
            // 通常の destroy() は爆発を 7〜10 個 setTimeout で撒くため、R 連打すると
            // 新ゲームに古いボスの爆発が突然出現し、点滅・重さの原因になる。
            if (this.boss.destroyImmediate) {
                this.boss.destroyImmediate();
            } else {
                if (this.boss.cancelDestroyTimers) this.boss.cancelDestroyTimers();
                this.boss.destroy(this.effects);
            }
            this.boss = null;
        }
        this.bossSpawnedWaves.clear();
        // クリーンアップタイマーも 0 に戻す。残ったまま新ゲームに入ると、
        // 開始直後に大規模 cleanup が走って表示中エフェクトが shift される。
        this.cleanupTimer = 0;
    }

    // ============================================
    // スポーン（縦スクロール 3D 版）
    // ============================================
    _spawnPOW(scrollZ) {
        const z = scrollZ + 30 + Math.random() * 10;
        const x = (Math.random() - 0.5) * 10;
        const pow = new POW(this.scene, new THREE.Vector3(x, 0, z));
        this.pows.push(pow);
    }

    _spawnFromPool(pool, playerPos, scrollZ) {
        const totalWeight = pool.reduce((sum, entry) => sum + entry.weight, 0);
        let roll = Math.random() * totalWeight;
        let selected = pool[0];
        for (const entry of pool) {
            roll -= entry.weight;
            if (roll <= 0) { selected = entry; break; }
        }

        // 屋上スナイパーは建物が見つからなければ通常スナイパーへフォールバック
        let perchedPos = null;
        if (selected.type === 'infantry' && selected.subType === 'perched_sniper') {
            perchedPos = this._findRooftopSpawn(playerPos, scrollZ);
            if (!perchedPos) {
                selected = { type: 'infantry', subType: 'sniper' };
            }
        }

        const spawnPos = perchedPos || this._getSpawnPosition(playerPos, selected.type, scrollZ);

        let enemy;
        switch (selected.type) {
            case 'infantry':
                enemy = new Infantry(this.scene, { position: spawnPos, subType: selected.subType });
                if (enemy.perched) enemy.perchY = spawnPos.y;
                break;
            case 'tank':
                enemy = new EnemyTank(this.scene, { position: spawnPos, subType: selected.subType });
                break;
            case 'aircraft':
                enemy = new Aircraft(this.scene, { position: spawnPos, subType: selected.subType });
                break;
        }

        if (enemy) {
            this.enemies.push(enemy);
            this.enemiesSpawnedInWave++;
        }
    }

    /**
     * 屋上スナイパー用の配置点を World の障害物から探す。
     * - プレイヤー前方〜やや前進した範囲の高い "block" 障害物 (radius>=3) を候補に
     * - 障害物の bounding box 上端を Y にして、上面の中央付近に少しランダムを加える
     * 候補がなければ null を返す。
     */
    _findRooftopSpawn(playerPos, scrollZ) {
        if (!this.world || typeof this.world.getObstacles !== 'function') return null;
        const obstacles = this.world.getObstacles();
        if (!obstacles || !obstacles.length) return null;

        const candidates = [];
        for (const { obj, info } of obstacles) {
            if (!info || info.destroyed) continue;
            if (info.type !== 'block') continue;          // 大型建物のみ
            if ((info.radius || 0) < 3.0) continue;       // 小物件は除外
            const z = obj.position.z;
            // プレイヤー前方寄りで画面内の建物を狙う
            if (z < playerPos.z + 6 || z > playerPos.z + 55) continue;
            candidates.push(obj);
        }
        if (!candidates.length) return null;

        const target = candidates[Math.floor(Math.random() * candidates.length)];
        const box = new THREE.Box3().setFromObject(target);
        if (!isFinite(box.max.y)) return null;
        // 上面中央付近に若干のランダム
        const cx = (box.min.x + box.max.x) * 0.5;
        const cz = (box.min.z + box.max.z) * 0.5;
        const halfX = Math.max(0.4, (box.max.x - box.min.x) * 0.25);
        const halfZ = Math.max(0.4, (box.max.z - box.min.z) * 0.25);
        return new THREE.Vector3(
            cx + (Math.random() - 0.5) * halfX,
            box.max.y + 0.02,
            cz + (Math.random() - 0.5) * halfZ,
        );
    }

    /**
     * 縦スクロール 3D 用スポーン位置
     * - 地上敵: 画面前方（+Z 方向）からスポーン、たまに後方からも
     * - 航空機: 画面上空の前方からスポーン
     */
    _getSpawnPosition(playerPos, type, scrollZ) {
        // 主に前方（進行方向 +Z）からスポーン、20%の確率で後方から
        const fromFront = Math.random() > 0.2;
        let x, y, z;

        if (type === 'aircraft') {
            // 航空機は画面外の低空から（砲身仰角で届く高度）
            z = fromFront ? scrollZ + 40 + Math.random() * 10 : scrollZ - 20 - Math.random() * 10;
            y = 5 + Math.random() * 2.5; // 5〜7.5m
            x = (Math.random() - 0.5) * 14;
        } else {
            // 地上敵は画面前端/後端から
            z = fromFront ? scrollZ + 32 + Math.random() * 10 : scrollZ - 18 - Math.random() * 8;
            y = 0;
            x = (Math.random() - 0.5) * 14;
        }

        return new THREE.Vector3(x, y, z);
    }

    _cleanup() {
        const scrollZ = this.getScrollZ();

        // 死亡した敵の破棄
        const deadEnemies = this.enemies.filter(e => !e.alive);
        deadEnemies.forEach(e => e.destroy());
        this.enemies = this.enemies.filter(e => e.alive);

        // 画面外の敵を強制除去（スクロール位置より 80 ユニット以上後ろ）
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            const ePos = this.enemies[i].getPosition();
            if (ePos.z < scrollZ - 80 || ePos.z > scrollZ + 120) {
                this.enemies[i].destroy();
                this.enemies.splice(i, 1);
            }
        }

        // 敵の弾丸: 画面外のものを削除
        this.enemies.forEach(enemy => {
            // 敵ごとの弾数上限（暴走対策）
            const MAX_ENEMY_PROJECTILES = 18;
            while (enemy.projectiles.length > MAX_ENEMY_PROJECTILES) {
                const old = enemy.projectiles.shift();
                if (old && old.destroy) old.destroy();
            }
            for (let i = enemy.projectiles.length - 1; i >= 0; i--) {
                const p = enemy.projectiles[i];
                if (!p.alive && !p.impactPending) {
                    p.destroy();
                    enemy.projectiles.splice(i, 1);
                } else if (p.alive) {
                    const pPos = p.getPosition ? p.getPosition() : (p.group ? p.group.position : null);
                    if (pPos && (pPos.z < scrollZ - 60 || pPos.z > scrollZ + 100)) {
                        p.destroy();
                        enemy.projectiles.splice(i, 1);
                    }
                }
            }
        });

        // ボス弾のクリーンアップ
        if (this.boss && this.boss.projectiles) {
            const MAX_BOSS_PROJECTILES = 36;
            while (this.boss.projectiles.length > MAX_BOSS_PROJECTILES) {
                const old = this.boss.projectiles.shift();
                if (old && old.destroy) old.destroy();
            }
            for (let i = this.boss.projectiles.length - 1; i >= 0; i--) {
                const p = this.boss.projectiles[i];
                if (!p.alive && !p.impactPending) {
                    p.destroy();
                    this.boss.projectiles.splice(i, 1);
                } else if (p.alive) {
                    const pPos = p.getPosition ? p.getPosition() : (p.group ? p.group.position : null);
                    if (pPos && (pPos.z < scrollZ - 60 || pPos.z > scrollZ + 110)) {
                        p.destroy();
                        this.boss.projectiles.splice(i, 1);
                    }
                }
            }
        }

        // エフェクトの破棄
        const deadEffects = this.effects.filter(e => !e.alive);
        deadEffects.forEach(e => { if (e.destroy) e.destroy(); });
        this.effects = this.effects.filter(e => e.alive);

        // エフェクト数の上限（後半シーンでの累積を抑制）
        // shift で配列から外しただけでは scene 上の Mesh は残るので、必ず destroy
        // （それが無ければ group を traverse して dispose）して確実に解放する。
        // 28→48 に緩和: 表示中の煙トレイル・炎・爆発が強制破壊で消える症状を抑制
        const MAX_EFFECTS = 48;
        while (this.effects.length > MAX_EFFECTS) {
            const oldest = this.effects.shift();
            this._forceDestroyEffect(oldest);
        }

        // アイテムの上限（20を超えた場合、古いものを削除）
        const MAX_ITEMS = 20;
        while (this.items.length > MAX_ITEMS) {
            const oldest = this.items.shift();
            if (oldest.destroy) oldest.destroy();
        }

        // POW の不要保持を防止
        for (let i = this.pows.length - 1; i >= 0; i--) {
            const pow = this.pows[i];
            const pz = pow.group ? pow.group.position.z : 0;
            if (!pow.alive || pz < scrollZ - 70 || pz > scrollZ + 130) {
                if (pow.destroy) pow.destroy();
                this.pows.splice(i, 1);
            }
        }
    }

    /**
     * エフェクトを安全に解放する。
     * - destroy() があればそれを優先（多重呼出しは各 destroy 側でガード済み）
     * - 無ければ group を traverse して geometry/material を dispose
     * - Explosion など共有ジオメトリを使う系も destroy 内で安全に扱われる
     */
    _forceDestroyEffect(effect) {
        if (!effect) return;
        if (typeof effect.destroy === 'function') {
            try {
                effect.destroy();
                return;
            } catch (_) { /* 多重呼出しの保険 */ }
        }
        effect.alive = false;
        if (effect.group && effect.group.parent) {
            effect.group.parent.remove(effect.group);
        }
        if (effect.group) {
            effect.group.traverse(child => {
                if (child.isMesh) {
                    if (child.geometry && child.geometry.dispose) child.geometry.dispose();
                    if (child.material && child.material.dispose) child.material.dispose();
                }
            });
        }
    }

    getAllEnemyProjectiles() {
        const all = [];
        this.enemies.forEach(enemy => {
            all.push(...enemy.projectiles);
        });
        if (this.boss) {
            all.push(...this.boss.projectiles);
        }
        return all;
    }

    getCurrentWave() {
        return this.waveIndex + 1;
    }

    // ============================================
    // ボススポーン（縦スクロール 3D 版）
    // ============================================
    _spawnBoss(waveNum, scrollZ) {
        let hp, subType;
        if (waveNum === 20) {
            hp = 1800;
            subType = 'tani_oh';  // 深部要塞ボス: 超強化飛行メカ
        } else if (waveNum === 16) {
            hp = 1500;
            subType = 'tani_oh';  // 終盤ボス: 超強化飛行メカ
        } else if (waveNum === 12) {
            hp = 1200;
            subType = 'tani_oh';  // 最終ボス: 大型飛行メカ（強化版）
        } else if (waveNum === 8) {
            hp = 800;
            subType = 'tani_oh';  // 中盤ボス: 飛行メカ
        } else {
            hp = 500;
            subType = 'di_cokka'; // 序盤ボス: 巨大装甲戦車
        }
        this.boss = new Boss(this.scene, {
            hp: hp,
            x: 0,
            z: scrollZ + 45,
            subType: subType,
            // 重要: 生成する Explosion を effects に登録させる。
            // これがないとマズルフラッシュ等が永遠に scene に残り重くなる
            effectSink: this.effects,
        });
        if (this.onBossHpChange) {
            this.onBossHpChange(this.boss.hp, this.boss.maxHp);
        }
        if (this.onBossSpawn) {
            this.onBossSpawn();
        }
    }
}
