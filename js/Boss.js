import * as THREE from 'three';
import { Projectile } from './Projectile.js';
import { Explosion } from './Explosion.js';

/**
 * ボスエネミー — Metal Slug風の巨大敵
 *
 * subType:
 *   'di_cokka'  — 中ボス: 巨大装甲戦車（Wave 3）
 *                  大きなキャタピラ、二連主砲、サイドミサイルポッド
 *                  パーツ破壊あり（装甲→砲塔→コア）
 *
 *   'tani_oh'   — 大ボス: 巨大飛行メカ（Wave 6）
 *                  ホバリング巨大機体、大型レーザー砲、ミサイル斉射
 *                  3段階フェーズ変化
 */
export class Boss {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.type = 'boss';
        this.subType = options.subType || 'di_cokka';
        this.alive = true;
        // 生成した爆発・マズルフラッシュを登録する外部 effects 配列
        // (GameManager.effects)。未設定だと update() されず scene に永遠に残る
        this.effectSink = options.effectSink || null;

        // ステータス（タイプ別 — Metal Slug 原作のボス倒しスコア相当）
        //   Di-Cokka 相当: 15000pt / Tani-Oh (ハイレッグ) 相当: 50000pt
        if (this.subType === 'tani_oh') {
            this.maxHp = options.hp || 800;
            this.scoreValue = 50000;
            this.damage = 30;
            this.speed = 3;
        } else {
            this.maxHp = options.hp || 500;
            this.scoreValue = 15000;
            this.damage = 25;
            this.speed = 2.5;
        }
        this.hp = this.maxHp;

        // パーツHP
        this.turretHp = this.maxHp * 0.3;
        this.armorHp = this.maxHp * 0.4;
        this.turretDestroyed = false;
        this.armorDestroyed = false;

        // 移動（+Z 前方スクロール版）
        this.group = new THREE.Group();
        // モデルのローカル +X = 砲身・機首方向。ワールド -Z（プレイヤー側）を向けるよう baseline 回転
        this.group.rotation.y = Math.PI / 2;
        this.targetZ = options.z ?? 30;
        this.entryComplete = false;

        // 攻撃
        this.projectiles = [];
        this.attackTimer = 0;
        this.attackPattern = 0;
        this.attackCooldown = 3.0;
        this.burstCount = 0;
        this.burstTimer = 0;
        this.charging = false;
        this.chargeSpeed = 18;
        this.chargeTimer = 0;

        // フラッシュ
        this.flashTimer = 0;

        // ダメージ煙
        this.smokeTimer = 0;
        this.smokePuffs = [];

        // ボブ（飛行メカ用）
        this.bobPhase = Math.random() * Math.PI * 2;

        // フェーズ（大ボス用）
        this.phase = 1;

        // モデル構築
        if (this.subType === 'tani_oh') {
            this._buildTaniOh();
        } else {
            this._buildDiCokka();
        }

        // 初期位置: プレイヤーから前方（+Z）に少し離れた所に登場させ、徐々に targetZ まで接近
        const entryZ = (options.z ?? 30) + 20;
        this.group.position.set(options.x || 0, this.subType === 'tani_oh' ? 8 : 0, entryZ);
        this.scene.add(this.group);
    }

    /* ========================================================
     *  Di-Cokka — 中ボス巨大装甲戦車
     * ======================================================== */
    _buildDiCokka() {
        const C = {
            hull:     0x6F8E88,  // 青緑の丸い要塞装甲
            hullDk:   0x314D4B,
            armor:    0xB3A77D,
            metal:    0x858B82,
            track:    0x1B1C18,
            turret:   0x4F7778,
            cannon:   0x2B363A,
            red:      0xBB2020,
            light:    0xDFFF72,
            rust:     0x8B552C,
            pipe:     0x6B3A28,
            claw:     0xD8C9A6,
            mark:     0xF4C542,
        };

        // ============ 巨大車体 ============
        // メインハル（角張った装甲ボックス）
        const hullGeo = new THREE.BoxGeometry(7, 2.8, 5);
        const hullMat = new THREE.MeshStandardMaterial({
            color: C.hull, roughness: 0.7, metalness: 0.3,
        });
        this.hullMesh = new THREE.Mesh(hullGeo, hullMat);
        this.hullMesh.position.y = 2.2;
        this.hullMesh.castShadow = true;
        this.group.add(this.hullMesh);

        // 車体上部の傾斜装甲
        const slopeGeo = new THREE.BoxGeometry(7, 0.8, 4.5);
        const slopeMat = new THREE.MeshStandardMaterial({ color: C.hullDk, roughness: 0.65, metalness: 0.35 });
        const slope = new THREE.Mesh(slopeGeo, slopeMat);
        slope.position.set(0, 3.8, 0);
        slope.rotation.x = 0.05;
        this.group.add(slope);

        // 車体前面の傾斜装甲（くさび型）
        const frontGeo = new THREE.BoxGeometry(0.8, 2.5, 4.8);
        const frontArmor = new THREE.Mesh(frontGeo, new THREE.MeshStandardMaterial({
            color: C.armor, roughness: 0.55, metalness: 0.4,
        }));
        frontArmor.position.set(3.8, 2.2, 0);
        frontArmor.rotation.z = -0.15;
        this.group.add(frontArmor);

        // コンセプト画像風の丸い上部装甲殻。箱形ハルにかぶせてシルエットを一新。
        const shellDome = new THREE.Mesh(
            new THREE.SphereGeometry(3.25, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.48),
            new THREE.MeshStandardMaterial({ color: C.hull, roughness: 0.42, metalness: 0.32 })
        );
        shellDome.scale.set(1.12, 0.55, 0.78);
        shellDome.position.set(-0.4, 3.0, 0);
        shellDome.castShadow = true;
        this.group.add(shellDome);

        const shellHighlight = new THREE.Mesh(
            new THREE.SphereGeometry(3.28, 18, 12, Math.PI * 0.12, Math.PI * 0.35, Math.PI * 0.06, Math.PI * 0.22),
            new THREE.MeshStandardMaterial({ color: 0xA8C2BC, roughness: 0.25, metalness: 0.25 })
        );
        shellHighlight.scale.copy(shellDome.scale);
        shellHighlight.position.copy(shellDome.position);
        this.group.add(shellHighlight);

        // ============ 装甲板グループ（破壊可能） ============
        this.armorGroup = new THREE.Group();

        // 前面追加装甲
        const extraArmor = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 2.0, 5.2),
            new THREE.MeshStandardMaterial({ color: C.armor, roughness: 0.5, metalness: 0.4 })
        );
        extraArmor.position.set(4.3, 2.2, 0);
        this.armorGroup.add(extraArmor);

        // 前面の牙状装甲板。破壊可能外装に含める。
        const fangMat = new THREE.MeshStandardMaterial({ color: C.claw, roughness: 0.74, metalness: 0.08 });
        for (let z = -2.15; z <= 2.15; z += 0.72) {
            const fang = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.72, 5), fangMat);
            fang.position.set(4.72, 0.62, z);
            fang.rotation.z = -Math.PI / 2;
            fang.rotation.y = z * 0.08;
            this.armorGroup.add(fang);
        }

        // サイドスカート（左右）
        for (let z of [-2.8, 2.8]) {
            const skirtGeo = new THREE.BoxGeometry(6.5, 1.2, 0.35);
            const skirt = new THREE.Mesh(skirtGeo, new THREE.MeshStandardMaterial({
                color: C.hullDk, roughness: 0.6, metalness: 0.3,
            }));
            skirt.position.set(0, 1.4, z);
            this.armorGroup.add(skirt);
        }

        // リベット（サイドスカート上下二段）
        const rivetMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.4, metalness: 0.65 });
        const rivetGeo = new THREE.SphereGeometry(0.07, 5, 4);
        for (let z of [-2.85, 2.85]) {
            for (let y of [1.9, 0.95]) {
                for (let x = -3.0; x <= 3.0; x += 0.45) {
                    const rivet = new THREE.Mesh(rivetGeo, rivetMat);
                    rivet.position.set(x, y, z);
                    this.armorGroup.add(rivet);
                }
            }
        }
        // 前面装甲リベット（垂直バンド）
        for (let y = 1.0; y <= 3.2; y += 0.35) {
            for (let z of [-2.0, -0.7, 0.7, 2.0]) {
                const rivet = new THREE.Mesh(rivetGeo, rivetMat);
                rivet.position.set(4.55, y, z);
                this.armorGroup.add(rivet);
            }
        }
        // 汚れ・サビ筋（縦のスミ入れ風 — サイドスカート）
        const grimeMat = new THREE.MeshBasicMaterial({ color: 0x1A1810, transparent: true, opacity: 0.55 });
        for (let z of [-2.83, 2.83]) {
            for (let x = -2.6; x <= 2.6; x += 0.7) {
                if (Math.random() < 0.55) {
                    const streak = new THREE.Mesh(
                        new THREE.PlaneGeometry(0.04 + Math.random() * 0.05, 0.7 + Math.random() * 0.4),
                        grimeMat
                    );
                    streak.position.set(x + (Math.random() - 0.5) * 0.2, 1.5, z + (z > 0 ? 0.001 : -0.001));
                    streak.rotation.y = z > 0 ? 0 : Math.PI;
                    this.armorGroup.add(streak);
                }
            }
        }
        // サビパッチ（オレンジ茶色のシミ）
        const rustPatchMat = new THREE.MeshBasicMaterial({ color: 0x6E3818, transparent: true, opacity: 0.5 });
        for (let z of [-2.84, 2.84]) {
            for (let i = 0; i < 5; i++) {
                const patch = new THREE.Mesh(
                    new THREE.CircleGeometry(0.12 + Math.random() * 0.08, 6),
                    rustPatchMat
                );
                patch.position.set(-2.8 + Math.random() * 5.6, 1.0 + Math.random() * 1.3, z);
                patch.rotation.y = z > 0 ? 0 : Math.PI;
                this.armorGroup.add(patch);
            }
        }

        // ミサイルポッド（左右サイド）
        for (let z of [-3.2, 3.2]) {
            const podGroup = new THREE.Group();
            const podBody = new THREE.Mesh(
                new THREE.BoxGeometry(1.8, 0.8, 0.7),
                new THREE.MeshStandardMaterial({ color: C.hullDk, roughness: 0.6, metalness: 0.3 })
            );
            podGroup.add(podBody);

            // ミサイル管（4本）
            for (let mx = -0.5; mx <= 0.5; mx += 0.35) {
                for (let my = -0.15; my <= 0.15; my += 0.3) {
                    const tube = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.1, 0.1, 1.9, 6),
                        new THREE.MeshStandardMaterial({ color: C.cannon, roughness: 0.3, metalness: 0.5 })
                    );
                    tube.rotation.z = Math.PI / 2;
                    tube.position.set(mx, my, 0);
                    podGroup.add(tube);
                }
            }
            podGroup.position.set(1.0, 3.0, z);
            this.armorGroup.add(podGroup);
        }

        this.group.add(this.armorGroup);

        // ============ 砲塔（回転ドーム + 二連主砲） ============
        this.turretGroup = new THREE.Group();
        this.turretGroup.position.set(-0.5, 4.2, 0);

        // 砲塔ドーム（大型）
        const turretGeo = new THREE.SphereGeometry(1.8, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2);
        const turretMat = new THREE.MeshStandardMaterial({
            color: C.turret, roughness: 0.5, metalness: 0.4,
        });
        this.turretMesh = new THREE.Mesh(turretGeo, turretMat);
        this.turretMesh.castShadow = true;
        this.turretGroup.add(this.turretMesh);

        // 砲塔ベースリング
        const turretBase = new THREE.Mesh(
            new THREE.CylinderGeometry(2.0, 2.2, 0.5, 14),
            new THREE.MeshStandardMaterial({ color: C.hullDk, roughness: 0.6, metalness: 0.3 })
        );
        turretBase.position.y = -0.15;
        this.turretGroup.add(turretBase);

        // ベースリングのボルト
        const tBoltMat = new THREE.MeshStandardMaterial({ color: 0x95956E, roughness: 0.4, metalness: 0.7 });
        for (let b = 0; b < 16; b++) {
            const ang = (b / 16) * Math.PI * 2;
            const bolt = new THREE.Mesh(new THREE.SphereGeometry(0.07, 4, 4), tBoltMat);
            bolt.position.set(Math.cos(ang) * 2.05, -0.05, Math.sin(ang) * 2.05);
            this.turretGroup.add(bolt);
        }

        // 砲塔上面装甲プレート（横帯）
        const topPlate = new THREE.Mesh(
            new THREE.BoxGeometry(2.0, 0.12, 2.4),
            new THREE.MeshStandardMaterial({ color: C.hullDk, roughness: 0.6, metalness: 0.4 })
        );
        topPlate.position.set(-0.2, 1.55, 0);
        this.turretGroup.add(topPlate);

        // 黄色三角警告マーク
        const triShape = new THREE.Shape();
        triShape.moveTo(0, 0.42);
        triShape.lineTo(0.38, -0.24);
        triShape.lineTo(-0.38, -0.24);
        triShape.closePath();
        const tri = new THREE.Mesh(
            new THREE.ShapeGeometry(triShape),
            new THREE.MeshStandardMaterial({
                color: C.mark, emissive: C.mark, emissiveIntensity: 0.2,
                roughness: 0.55, side: THREE.DoubleSide,
            })
        );
        tri.position.set(1.55, 0.42, 0);
        tri.rotation.y = Math.PI / 2;
        this.turretGroup.add(tri);

        // 二連主砲
        this.barrelGroup = new THREE.Group();
        const barrelMat = new THREE.MeshStandardMaterial({
            color: C.cannon, roughness: 0.35, metalness: 0.65,
        });
        const muzzleMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.3, metalness: 0.55 });
        for (let z of [-0.55, 0.55]) {
            // 砲身根本のスリーブ
            const sleeve = new THREE.Mesh(
                new THREE.CylinderGeometry(0.36, 0.36, 0.5, 10),
                new THREE.MeshStandardMaterial({ color: C.hullDk, roughness: 0.5, metalness: 0.5 })
            );
            sleeve.rotation.z = Math.PI / 2;
            sleeve.position.set(0.5, 0.4, z);
            this.barrelGroup.add(sleeve);

            // 砲身（前方に向かって細る）
            const barrel = new THREE.Mesh(
                new THREE.CylinderGeometry(0.22, 0.30, 4.5, 10),
                barrelMat
            );
            barrel.rotation.z = Math.PI / 2;
            barrel.position.set(2.25, 0.4, z);
            this.barrelGroup.add(barrel);

            // マズルブレーキ二段（外筒 + 先端ベル）
            const muzzleOuter = new THREE.Mesh(
                new THREE.CylinderGeometry(0.36, 0.32, 0.55, 10),
                muzzleMat
            );
            muzzleOuter.rotation.z = Math.PI / 2;
            muzzleOuter.position.set(4.55, 0.4, z);
            this.barrelGroup.add(muzzleOuter);

            const muzzleTip = new THREE.Mesh(
                new THREE.CylinderGeometry(0.32, 0.40, 0.35, 10),
                muzzleMat
            );
            muzzleTip.rotation.z = Math.PI / 2;
            muzzleTip.position.set(5.0, 0.4, z);
            this.barrelGroup.add(muzzleTip);

            // マズルブレーキのスリット（ベント）
            for (let s of [-Math.PI / 2, Math.PI / 2]) {
                const slit = new THREE.Mesh(
                    new THREE.BoxGeometry(0.4, 0.07, 0.16),
                    new THREE.MeshBasicMaterial({ color: 0x080808 })
                );
                slit.position.set(4.55, 0.4 + Math.sin(s) * 0.3, z + Math.cos(s) * 0.3);
                slit.rotation.x = s;
                this.barrelGroup.add(slit);
            }

            // 砲身リング（補強帯）
            for (let rx = 1.0; rx <= 3.6; rx += 0.85) {
                const ring = new THREE.Mesh(
                    new THREE.TorusGeometry(0.27, 0.04, 6, 12),
                    muzzleMat
                );
                ring.position.set(rx, 0.4, z);
                ring.rotation.y = Math.PI / 2;
                this.barrelGroup.add(ring);
            }
        }
        // 二連砲の中央ヨーク（連結板）
        const yoke = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.7, 1.4),
            new THREE.MeshStandardMaterial({ color: C.hullDk, roughness: 0.5, metalness: 0.5 })
        );
        yoke.position.set(0.55, 0.4, 0);
        this.barrelGroup.add(yoke);

        this.turretGroup.add(this.barrelGroup);

        // 同軸機銃（マウント付き）
        const mgMount = new THREE.Mesh(
            new THREE.BoxGeometry(0.3, 0.3, 0.3),
            new THREE.MeshStandardMaterial({ color: C.hullDk, roughness: 0.5, metalness: 0.4 })
        );
        mgMount.position.set(1.55, 1.05, 0);
        this.turretGroup.add(mgMount);
        this.mgBarrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.07, 0.09, 1.6, 6),
            new THREE.MeshStandardMaterial({ color: C.cannon, metalness: 0.6, roughness: 0.4 })
        );
        this.mgBarrel.rotation.z = Math.PI / 2;
        this.mgBarrel.position.set(2.4, 1.05, 0);
        this.turretGroup.add(this.mgBarrel);
        // 機銃の冷却フィン
        for (let fx = 1.95; fx <= 2.85; fx += 0.12) {
            const fin = new THREE.Mesh(
                new THREE.TorusGeometry(0.11, 0.015, 4, 8),
                muzzleMat
            );
            fin.position.set(fx, 1.05, 0);
            fin.rotation.y = Math.PI / 2;
            this.turretGroup.add(fin);
        }

        // 指揮官ハッチ（円筒 + ふた）
        const hatchBase = new THREE.Mesh(
            new THREE.CylinderGeometry(0.42, 0.45, 0.25, 12),
            new THREE.MeshStandardMaterial({ color: C.hullDk, roughness: 0.55, metalness: 0.4 })
        );
        hatchBase.position.set(-0.6, 1.7, -0.3);
        this.turretGroup.add(hatchBase);
        const hatchLid = new THREE.Mesh(
            new THREE.CylinderGeometry(0.4, 0.4, 0.1, 12),
            new THREE.MeshStandardMaterial({ color: C.armor, roughness: 0.5, metalness: 0.45 })
        );
        hatchLid.position.set(-0.6, 1.86, -0.3);
        this.turretGroup.add(hatchLid);
        // ハッチのヒンジ
        const hinge = new THREE.Mesh(
            new THREE.BoxGeometry(0.2, 0.06, 0.08),
            tBoltMat
        );
        hinge.position.set(-0.6, 1.92, -0.7);
        this.turretGroup.add(hinge);
        // ハッチのボルトリング
        for (let b = 0; b < 8; b++) {
            const ang = (b / 8) * Math.PI * 2;
            const bolt = new THREE.Mesh(new THREE.SphereGeometry(0.04, 4, 4), tBoltMat);
            bolt.position.set(-0.6 + Math.cos(ang) * 0.36, 1.83, -0.3 + Math.sin(ang) * 0.36);
            this.turretGroup.add(bolt);
        }

        // ペリスコープ（ハッチの上）
        const periscope = new THREE.Mesh(
            new THREE.BoxGeometry(0.22, 0.45, 0.16),
            new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.3, metalness: 0.55 })
        );
        periscope.position.set(0.2, 1.85, 0.1);
        this.turretGroup.add(periscope);
        // ペリスコープのレンズ
        const periLens = new THREE.Mesh(
            new THREE.PlaneGeometry(0.16, 0.1),
            new THREE.MeshBasicMaterial({ color: 0x88EEFF })
        );
        periLens.position.set(0.32, 1.92, 0.1);
        periLens.rotation.y = Math.PI / 2;
        this.turretGroup.add(periLens);

        // 砲塔側面のグリップハンドレール
        for (let z of [-1.5, 1.5]) {
            const rail = new THREE.Mesh(
                new THREE.TorusGeometry(0.4, 0.025, 4, 10, Math.PI),
                muzzleMat
            );
            rail.position.set(-0.8, 0.6, z);
            rail.rotation.x = Math.PI / 2;
            rail.rotation.y = z > 0 ? 0 : Math.PI;
            this.turretGroup.add(rail);
        }

        // 砲塔白色番号プレート
        const turretPlate = new THREE.Mesh(
            new THREE.PlaneGeometry(0.5, 0.35),
            new THREE.MeshBasicMaterial({ color: 0xE8DEB4 })
        );
        turretPlate.position.set(-1.4, 0.5, 1.55);
        turretPlate.rotation.y = Math.PI / 2;
        this.turretGroup.add(turretPlate);

        this.group.add(this.turretGroup);

        // ============ 大型キャタピラ（左右） ============
        const trackBeltMat = new THREE.MeshStandardMaterial({
            color: C.track, roughness: 0.95, metalness: 0.2,
        });
        const trackInnerMat = new THREE.MeshStandardMaterial({
            color: 0x101008, roughness: 0.95, metalness: 0.15,
        });
        const toothPlateMat = new THREE.MeshStandardMaterial({
            color: C.claw, roughness: 0.78, metalness: 0.08,
        });
        const clawGeo = new THREE.BoxGeometry(0.32, 0.22, 1.15);
        const padGeo = new THREE.BoxGeometry(0.42, 0.12, 1.05);
        for (let side of [-1, 1]) {
            const trackGroup = new THREE.Group();

            // キャタピラ本体（外側）
            const trackGeo = new THREE.BoxGeometry(7.6, 1.8, 1.1);
            const track = new THREE.Mesh(trackGeo, trackBeltMat);
            track.position.set(0, 0.85, 0);
            trackGroup.add(track);

            // 内側ベルト（深さを出す）
            const inner = new THREE.Mesh(
                new THREE.BoxGeometry(7.4, 1.4, 0.9),
                trackInnerMat
            );
            inner.position.set(0, 0.85, side * -0.1);
            trackGroup.add(inner);

            // クローティース（外周一周）
            const teethSpacing = 0.4;
            // 上面
            for (let x = -3.5; x <= 3.5; x += teethSpacing) {
                const claw = new THREE.Mesh(clawGeo, toothPlateMat);
                claw.position.set(x, 1.78, 0);
                trackGroup.add(claw);
                // パッド（プレート）
                const pad = new THREE.Mesh(padGeo, trackInnerMat);
                pad.position.set(x, 1.72, 0);
                trackGroup.add(pad);
            }
            // 下面
            for (let x = -3.5; x <= 3.5; x += teethSpacing) {
                const claw = new THREE.Mesh(clawGeo, toothPlateMat);
                claw.position.set(x, -0.08, 0);
                trackGroup.add(claw);
                const pad = new THREE.Mesh(padGeo, trackInnerMat);
                pad.position.set(x, -0.02, 0);
                trackGroup.add(pad);
            }
            // 前後カーブ部
            for (let i = 0; i < 6; i++) {
                const a = (i / 6) * Math.PI;
                // 後端
                const cBack = new THREE.Mesh(clawGeo, toothPlateMat);
                cBack.position.set(-3.8 - Math.sin(a) * 0.15, 0.85 - Math.cos(a) * 0.95, 0);
                cBack.rotation.z = a;
                trackGroup.add(cBack);
                // 前端
                const cFront = new THREE.Mesh(clawGeo, toothPlateMat);
                cFront.position.set(3.8 + Math.sin(a) * 0.15, 0.85 + Math.cos(a) * 0.95, 0);
                cFront.rotation.z = -a;
                trackGroup.add(cFront);
            }

            // 転輪（6個）— ハブ＋ボルトリング付き
            const wheelGeo = new THREE.CylinderGeometry(0.62, 0.62, 0.3, 14);
            const wheelMat = new THREE.MeshStandardMaterial({
                color: C.metal, roughness: 0.45, metalness: 0.5,
            });
            const hubMat = new THREE.MeshStandardMaterial({ color: 0x2A2A22, roughness: 0.5, metalness: 0.5 });
            const boltMat = new THREE.MeshStandardMaterial({ color: 0x95956E, roughness: 0.4, metalness: 0.7 });
            for (let i = 0; i < 6; i++) {
                const wx = -3.0 + i * 1.2;
                const wheel = new THREE.Mesh(wheelGeo, wheelMat);
                wheel.position.set(wx, 0.85, side * 0.18);
                wheel.rotation.x = Math.PI / 2;
                trackGroup.add(wheel);

                const hub = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.22, 0.22, 0.34, 8),
                    hubMat
                );
                hub.position.set(wx, 0.85, side * 0.18);
                hub.rotation.x = Math.PI / 2;
                trackGroup.add(hub);

                // ボルトリング（6本）
                for (let b = 0; b < 6; b++) {
                    const ang = (b / 6) * Math.PI * 2;
                    const bolt = new THREE.Mesh(new THREE.SphereGeometry(0.05, 4, 4), boltMat);
                    bolt.position.set(wx + Math.cos(ang) * 0.4, 0.85 + Math.sin(ang) * 0.4, side * 0.34);
                    trackGroup.add(bolt);
                }
            }

            // 駆動輪（前: スプロケット付き、後: テンショナー）
            const sprocketCore = new THREE.Mesh(
                new THREE.CylinderGeometry(0.5, 0.5, 0.28, 14),
                wheelMat
            );
            sprocketCore.position.set(3.5, 1.2, side * 0.15);
            sprocketCore.rotation.x = Math.PI / 2;
            trackGroup.add(sprocketCore);
            // スプロケット歯（10本）
            const sproToothGeo = new THREE.BoxGeometry(0.14, 0.22, 0.34);
            for (let t = 0; t < 10; t++) {
                const ang = (t / 10) * Math.PI * 2;
                const tooth = new THREE.Mesh(sproToothGeo, wheelMat);
                tooth.position.set(3.5 + Math.cos(ang) * 0.55, 1.2 + Math.sin(ang) * 0.55, side * 0.15);
                tooth.rotation.z = ang;
                trackGroup.add(tooth);
            }
            // 後部テンショナー
            const tensioner = new THREE.Mesh(
                new THREE.CylinderGeometry(0.45, 0.45, 0.26, 12),
                wheelMat
            );
            tensioner.position.set(-3.5, 1.2, side * 0.15);
            tensioner.rotation.x = Math.PI / 2;
            trackGroup.add(tensioner);
            const tHub = new THREE.Mesh(
                new THREE.CylinderGeometry(0.18, 0.18, 0.3, 6),
                hubMat
            );
            tHub.position.copy(tensioner.position);
            tHub.rotation.x = Math.PI / 2;
            trackGroup.add(tHub);

            // キャタピラ上面カバー（フェンダー）— 反り上げ
            const cover = new THREE.Mesh(
                new THREE.BoxGeometry(7.2, 0.18, 1.2),
                new THREE.MeshStandardMaterial({ color: C.hullDk, roughness: 0.7 })
            );
            cover.position.set(0, 1.85, 0);
            trackGroup.add(cover);
            // フェンダー前後の傾斜
            for (let dir of [-1, 1]) {
                const flap = new THREE.Mesh(
                    new THREE.BoxGeometry(0.9, 0.15, 1.15),
                    new THREE.MeshStandardMaterial({ color: C.hullDk, roughness: 0.7 })
                );
                flap.position.set(dir * 3.7, 1.7, 0);
                flap.rotation.z = dir * 0.45;
                trackGroup.add(flap);
            }
            // 泥よけリベット
            for (let x = -3.0; x <= 3.0; x += 0.6) {
                const rb = new THREE.Mesh(rivetGeo, rivetMat);
                rb.position.set(x, 1.94, 0);
                trackGroup.add(rb);
            }

            trackGroup.position.z = side * 2.8;
            this.group.add(trackGroup);
        }

        // ============ ディテール ============
        // ヘッドライト（2対）
        for (let z of [-1.8, 1.8]) {
            const lightGeo = new THREE.SphereGeometry(0.25, 8, 6);
            const lightMat = new THREE.MeshBasicMaterial({ color: C.light });
            const light = new THREE.Mesh(lightGeo, lightMat);
            light.position.set(4.0, 2.5, z);
            this.group.add(light);
        }

        // 排気管（後部）
        for (let z of [-1.2, 1.2]) {
            const pipeGeo = new THREE.CylinderGeometry(0.15, 0.18, 1.5, 6);
            const pipe = new THREE.Mesh(pipeGeo, new THREE.MeshStandardMaterial({
                color: C.pipe, roughness: 0.4, metalness: 0.5,
            }));
            pipe.position.set(-3.8, 3.0, z);
            pipe.rotation.z = Math.PI / 2 + 0.2;
            this.group.add(pipe);
        }

        // 反乱軍の星マーク（5点星 + 黒輪郭 + 白サークル）
        const starShape = new THREE.Shape();
        const starOuter = 0.65, starInner = 0.27;
        for (let i = 0; i < 10; i++) {
            const r = i % 2 === 0 ? starOuter : starInner;
            const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
            const px = Math.cos(a) * r;
            const py = Math.sin(a) * r;
            if (i === 0) starShape.moveTo(px, py);
            else starShape.lineTo(px, py);
        }
        starShape.closePath();
        const starGeo = new THREE.ShapeGeometry(starShape);
        const starMat = new THREE.MeshStandardMaterial({
            color: C.red, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.1,
            emissive: 0x441010, emissiveIntensity: 0.25,
        });
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xF0E8C8, side: THREE.DoubleSide });
        const blackMat = new THREE.MeshBasicMaterial({ color: 0x10120E, side: THREE.DoubleSide });
        for (let z of [-3.06, 3.06]) {
            // 黒い四角の地（旗フレーム）
            const frame = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.0), blackMat);
            frame.position.set(-0.5, 2.4, z);
            frame.rotation.y = z > 0 ? 0 : Math.PI;
            this.group.add(frame);
            // 白いリング
            const ring = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.92, 24), ringMat);
            ring.position.set(-0.5, 2.4, z + (z > 0 ? 0.005 : -0.005));
            ring.rotation.y = z > 0 ? 0 : Math.PI;
            this.group.add(ring);
            // 赤い星
            const star = new THREE.Mesh(starGeo, starMat);
            star.position.set(-0.5, 2.4, z + (z > 0 ? 0.01 : -0.01));
            star.rotation.y = z > 0 ? 0 : Math.PI;
            this.group.add(star);
        }
        // 危険ストライプ（前面装甲）
        const stripeMat = new THREE.MeshBasicMaterial({ color: 0xE8C040 });
        const stripeBlack = new THREE.MeshBasicMaterial({ color: 0x18180E });
        for (let i = 0; i < 6; i++) {
            const isBlack = i % 2 === 0;
            const stripe = new THREE.Mesh(
                new THREE.PlaneGeometry(0.18, 0.5),
                isBlack ? stripeBlack : stripeMat
            );
            stripe.position.set(4.66, 0.85, -2.0 + i * 0.4);
            stripe.rotation.y = Math.PI / 2;
            stripe.rotation.x = -0.15;
            this.group.add(stripe);
        }

        // アンテナ
        const antenna = new THREE.Mesh(
            new THREE.CylinderGeometry(0.02, 0.02, 3, 4),
            new THREE.MeshStandardMaterial({ color: C.metal, metalness: 0.5 })
        );
        antenna.position.set(-1.5, 5.5, 0.8);
        antenna.rotation.z = 0.15;
        this.group.add(antenna);

        // 予備キャタピラ（車体後部に装着）
        const spareTrack = new THREE.Mesh(
            new THREE.TorusGeometry(0.6, 0.12, 6, 12),
            new THREE.MeshStandardMaterial({ color: C.track, roughness: 0.9 })
        );
        spareTrack.position.set(-3.5, 2.8, 0);
        spareTrack.rotation.y = Math.PI / 2;
        this.group.add(spareTrack);
    }

    /* ========================================================
     *  Tani Oh — 大ボス巨大飛行メカ
     * ======================================================== */
    _buildTaniOh() {
        const C = {
            body:     0x47777C,  // 青緑の低空ホバーガンシップ
            bodyDk:   0x253F46,
            armor:    0xA59669,
            metal:    0x8EA0A0,
            engine:   0x202A2E,
            red:      0xCC2020,
            orange:   0xFF7700,
            light:    0xA6F7FF,
            glass:    0x2B8990,
        };

        // ============ メイン機体（巨大な楕円形） ============
        const bodyGeo = new THREE.SphereGeometry(3.5, 16, 12);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: C.body, roughness: 0.5, metalness: 0.5,
        });
        this.hullMesh = new THREE.Mesh(bodyGeo, bodyMat);
        this.hullMesh.scale.set(1.8, 0.7, 1.0);
        this.hullMesh.castShadow = true;
        this.group.add(this.hullMesh);

        // 機体下部の装甲板
        const bellyGeo = new THREE.BoxGeometry(10, 0.8, 5);
        const belly = new THREE.Mesh(bellyGeo, new THREE.MeshStandardMaterial({
            color: C.bodyDk, roughness: 0.6, metalness: 0.4,
        }));
        belly.position.y = -2.0;
        this.group.add(belly);

        // 機体上部の装甲リッジ（スパイン）
        const spine = new THREE.Mesh(
            new THREE.BoxGeometry(8, 0.5, 1.0),
            new THREE.MeshStandardMaterial({ color: C.armor, roughness: 0.45, metalness: 0.55 })
        );
        spine.position.set(0, 1.9, 0);
        this.group.add(spine);
        // スパインのリベット
        const tBoltMatT = new THREE.MeshStandardMaterial({ color: 0x9999B0, roughness: 0.4, metalness: 0.7 });
        for (let x = -3.5; x <= 3.5; x += 0.7) {
            for (let z of [-0.45, 0.45]) {
                const bolt = new THREE.Mesh(new THREE.SphereGeometry(0.06, 4, 4), tBoltMatT);
                bolt.position.set(x, 2.18, z);
                this.group.add(bolt);
            }
        }

        // エネルギーコア（中央下部に光るリング + ガラス球）
        const coreGlow = new THREE.Mesh(
            new THREE.SphereGeometry(0.55, 14, 10),
            new THREE.MeshBasicMaterial({
                color: C.light, transparent: true, opacity: 0.9,
            })
        );
        coreGlow.position.set(0.5, -1.9, 0);
        this.group.add(coreGlow);
        this.energyCore = coreGlow;
        // コアハロー
        const coreHalo = new THREE.Mesh(
            new THREE.SphereGeometry(0.85, 12, 10),
            new THREE.MeshBasicMaterial({
                color: C.light, transparent: true, opacity: 0.25,
                blending: THREE.AdditiveBlending, depthWrite: false,
            })
        );
        coreHalo.position.copy(coreGlow.position);
        this.group.add(coreHalo);
        this.energyHalo = coreHalo;
        // コアリング
        for (let i = 0; i < 3; i++) {
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(0.7 + i * 0.12, 0.025, 6, 20),
                new THREE.MeshBasicMaterial({
                    color: C.light, transparent: true, opacity: 0.6,
                    blending: THREE.AdditiveBlending, depthWrite: false,
                })
            );
            ring.position.copy(coreGlow.position);
            ring.rotation.x = Math.PI / 2 + i * 0.4;
            this.group.add(ring);
        }

        // ============ コックピット（前面ガラス） ============
        const cockpitGeo = new THREE.SphereGeometry(1.2, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2);
        const cockpit = new THREE.Mesh(cockpitGeo, new THREE.MeshStandardMaterial({
            color: C.glass, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.7,
        }));
        cockpit.position.set(4.5, 0.5, 0);
        cockpit.rotation.z = -Math.PI / 2;
        this.group.add(cockpit);

        // コックピットフレーム
        for (let angle = -0.4; angle <= 0.4; angle += 0.4) {
            const frame = new THREE.Mesh(
                new THREE.BoxGeometry(0.06, 1.2, 0.06),
                new THREE.MeshStandardMaterial({ color: C.metal, metalness: 0.6 })
            );
            frame.position.set(4.5 + Math.cos(angle) * 0.3, 0.5, Math.sin(angle) * 1.0);
            frame.rotation.z = -Math.PI / 2 + angle;
            this.group.add(frame);
        }

        // ============ 装甲板グループ（破壊可能） ============
        this.armorGroup = new THREE.Group();

        // 前面装甲
        const frontArmor = new THREE.Mesh(
            new THREE.BoxGeometry(0.6, 2.5, 6),
            new THREE.MeshStandardMaterial({ color: C.armor, roughness: 0.5, metalness: 0.4 })
        );
        frontArmor.position.set(5.5, -0.5, 0);
        this.armorGroup.add(frontArmor);

        // サイドウイング（左右）
        for (let z of [-1, 1]) {
            const wingGeo = new THREE.BoxGeometry(4, 0.3, 3);
            const wing = new THREE.Mesh(wingGeo, new THREE.MeshStandardMaterial({
                color: C.body, roughness: 0.5, metalness: 0.5,
            }));
            wing.position.set(-1, -0.5, z * 4.5);
            wing.rotation.x = z * 0.1;
            this.armorGroup.add(wing);

            // ウイング先端のミサイルラック
            const rackGroup = new THREE.Group();
            for (let mx = -0.8; mx <= 0.8; mx += 0.55) {
                const missile = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.1, 0.08, 1.2, 6),
                    new THREE.MeshStandardMaterial({ color: C.bodyDk, roughness: 0.4, metalness: 0.4 })
                );
                missile.rotation.z = Math.PI / 2;
                missile.position.set(mx, -0.3, 0);
                rackGroup.add(missile);

                // ミサイル先端（赤）
                const tip = new THREE.Mesh(
                    new THREE.ConeGeometry(0.1, 0.3, 6),
                    new THREE.MeshStandardMaterial({ color: C.red })
                );
                tip.rotation.z = -Math.PI / 2;
                tip.position.set(mx + 0.7, -0.3, 0);
                rackGroup.add(tip);
            }
            rackGroup.position.set(-1, -0.8, z * 5.8);
            this.armorGroup.add(rackGroup);
        }

        this.group.add(this.armorGroup);

        // サイドダクトファン。ホバー機らしいシルエットを追加する。
        this.ductFans = [];
        const ductMat = new THREE.MeshStandardMaterial({ color: C.engine, roughness: 0.32, metalness: 0.62 });
        const bladeMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.26, metalness: 0.7 });
        for (const z of [-4.6, 4.6]) {
            for (const x of [-2.4, 2.0]) {
                const fanGroup = new THREE.Group();
                const duct = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.09, 8, 22), ductMat);
                fanGroup.add(duct);
                const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 12), bladeMat);
                hub.rotation.x = Math.PI / 2;
                fanGroup.add(hub);
                for (let i = 0; i < 4; i++) {
                    const blade = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.07, 0.035), bladeMat);
                    blade.rotation.z = i * Math.PI / 2;
                    fanGroup.add(blade);
                }
                fanGroup.position.set(x, -0.85, z);
                this.group.add(fanGroup);
                this.ductFans.push(fanGroup);
            }
        }

        // ============ 砲塔（下部の大型レーザー砲） ============
        this.turretGroup = new THREE.Group();
        this.turretGroup.position.set(2, -2.5, 0);

        // 砲塔ベース
        const turretBaseGeo = new THREE.CylinderGeometry(1.5, 1.8, 0.8, 12);
        this.turretMesh = new THREE.Mesh(turretBaseGeo, new THREE.MeshStandardMaterial({
            color: C.bodyDk, roughness: 0.5, metalness: 0.4,
        }));
        this.turretGroup.add(this.turretMesh);

        // 大型砲身
        this.barrelGroup = new THREE.Group();
        const mainBarrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.35, 0.45, 5, 10),
            new THREE.MeshStandardMaterial({ color: C.engine, roughness: 0.3, metalness: 0.6 })
        );
        mainBarrel.rotation.z = Math.PI / 2;
        mainBarrel.position.set(2.5, 0, 0);
        this.barrelGroup.add(mainBarrel);

        // 砲口エネルギーリング
        for (let rx = 1.5; rx <= 4.5; rx += 1.0) {
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(0.45, 0.04, 6, 12),
                new THREE.MeshStandardMaterial({ color: C.light, emissive: C.light, emissiveIntensity: 0.3 })
            );
            ring.position.set(rx, 0, 0);
            ring.rotation.y = Math.PI / 2;
            this.barrelGroup.add(ring);
        }

        // 砲口（光る）
        const muzzleGlow = new THREE.Mesh(
            new THREE.SphereGeometry(0.4, 8, 6),
            new THREE.MeshBasicMaterial({ color: C.light, transparent: true, opacity: 0.6 })
        );
        muzzleGlow.position.set(5.2, 0, 0);
        this.barrelGroup.add(muzzleGlow);
        this.muzzleGlow = muzzleGlow;

        this.turretGroup.add(this.barrelGroup);

        // 副砲（2門）
        for (let z of [-1.2, 1.2]) {
            const subBarrel = new THREE.Mesh(
                new THREE.CylinderGeometry(0.12, 0.15, 2.5, 6),
                new THREE.MeshStandardMaterial({ color: C.engine, roughness: 0.3, metalness: 0.5 })
            );
            subBarrel.rotation.z = Math.PI / 2;
            subBarrel.position.set(1.5, 0.3, z);
            this.turretGroup.add(subBarrel);
        }

        this.group.add(this.turretGroup);

        // ============ エンジンポッド（後部左右） ============
        this.thrusterGlows = [];
        this.thrusterCones = [];
        for (let z of [-3, 3]) {
            const engineGroup = new THREE.Group();

            // エンジン本体
            const engineBody = new THREE.Mesh(
                new THREE.CylinderGeometry(0.8, 1.0, 2.5, 10),
                new THREE.MeshStandardMaterial({ color: C.engine, roughness: 0.4, metalness: 0.55 })
            );
            engineBody.rotation.z = Math.PI / 2;
            engineGroup.add(engineBody);

            // 装甲帯
            for (let bx of [-0.5, 0, 0.5]) {
                const band = new THREE.Mesh(
                    new THREE.TorusGeometry(0.92, 0.06, 6, 14),
                    new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.35, metalness: 0.6 })
                );
                band.rotation.y = Math.PI / 2;
                band.position.x = bx;
                engineGroup.add(band);
            }

            // 排気口本体（黒い内側 + オレンジ発光）
            const exhaustHole = new THREE.Mesh(
                new THREE.CylinderGeometry(0.65, 0.55, 0.15, 12),
                new THREE.MeshBasicMaterial({ color: 0x080404 })
            );
            exhaustHole.rotation.z = Math.PI / 2;
            exhaustHole.position.x = -1.32;
            engineGroup.add(exhaustHole);

            const exhaustGlow = new THREE.Mesh(
                new THREE.CylinderGeometry(0.55, 0.42, 0.25, 12),
                new THREE.MeshBasicMaterial({
                    color: C.orange, transparent: true, opacity: 0.95,
                    blending: THREE.AdditiveBlending, depthWrite: false,
                })
            );
            exhaustGlow.rotation.z = Math.PI / 2;
            exhaustGlow.position.x = -1.45;
            engineGroup.add(exhaustGlow);
            this.thrusterGlows.push(exhaustGlow);

            // 排気炎コーン（後方に伸びる）
            const flameCone = new THREE.Mesh(
                new THREE.ConeGeometry(0.5, 1.8, 10, 1, true),
                new THREE.MeshBasicMaterial({
                    color: 0xFFB04A, transparent: true, opacity: 0.7,
                    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
                })
            );
            flameCone.rotation.z = Math.PI / 2;
            flameCone.position.x = -2.4;
            engineGroup.add(flameCone);
            this.thrusterCones.push(flameCone);

            // 内側コア（白熱）
            const flameCore = new THREE.Mesh(
                new THREE.ConeGeometry(0.25, 1.0, 8, 1, true),
                new THREE.MeshBasicMaterial({
                    color: 0xFFEEB4, transparent: true, opacity: 0.9,
                    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
                })
            );
            flameCore.rotation.z = Math.PI / 2;
            flameCore.position.x = -2.0;
            engineGroup.add(flameCore);
            this.thrusterCones.push(flameCore);

            // インテーク（前方）
            const intake = new THREE.Mesh(
                new THREE.CylinderGeometry(0.85, 0.9, 0.2, 12),
                new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.3, metalness: 0.65 })
            );
            intake.rotation.z = Math.PI / 2;
            intake.position.x = 1.3;
            engineGroup.add(intake);
            // インテークブレード
            for (let bi = 0; bi < 8; bi++) {
                const ang = (bi / 8) * Math.PI * 2;
                const blade = new THREE.Mesh(
                    new THREE.BoxGeometry(0.06, 0.7, 0.05),
                    new THREE.MeshStandardMaterial({ color: 0x2A2A38, roughness: 0.5, metalness: 0.5 })
                );
                blade.position.set(1.36, Math.sin(ang) * 0.4, Math.cos(ang) * 0.4);
                blade.rotation.x = ang;
                engineGroup.add(blade);
            }

            engineGroup.position.set(-4, 0, z);
            this.group.add(engineGroup);
        }

        // 浮遊リングシャドウ（地表に向けた光輪）
        const hoverRing = new THREE.Mesh(
            new THREE.RingGeometry(2.5, 4.2, 32),
            new THREE.MeshBasicMaterial({
                color: 0x66CCFF, transparent: true, opacity: 0.18,
                blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
            })
        );
        hoverRing.rotation.x = -Math.PI / 2;
        hoverRing.position.set(0, -7, 0);
        this.group.add(hoverRing);
        this.hoverRing = hoverRing;

        // ============ ディテール ============
        // 赤いストライプ
        const stripe = new THREE.Mesh(
            new THREE.BoxGeometry(12, 0.3, 0.1),
            new THREE.MeshStandardMaterial({ color: C.red })
        );
        stripe.position.set(0, 0, 3.55);
        this.group.add(stripe);
        const stripe2 = stripe.clone();
        stripe2.position.z = -3.55;
        this.group.add(stripe2);

        // アンテナアレイ
        for (let x of [-2, -3]) {
            const ant = new THREE.Mesh(
                new THREE.CylinderGeometry(0.02, 0.02, 2, 4),
                new THREE.MeshStandardMaterial({ color: C.metal, metalness: 0.5 })
            );
            ant.position.set(x, 2.5, 0);
            this.group.add(ant);
        }

        // 警告灯（赤い点滅）
        for (let pos of [[5, 1, 0], [-5, 1, 0], [0, 2.5, 3], [0, 2.5, -3]]) {
            const warningLight = new THREE.Mesh(
                new THREE.SphereGeometry(0.15, 6, 4),
                new THREE.MeshBasicMaterial({ color: C.red })
            );
            warningLight.position.set(...pos);
            this.group.add(warningLight);
        }

        // 機体番号
        // (テキストはThree.jsでは難しいので、代わりにマーキングプレート)
        const plate = new THREE.Mesh(
            new THREE.BoxGeometry(1.5, 0.6, 0.05),
            new THREE.MeshStandardMaterial({ color: 0x333333 })
        );
        plate.position.set(-2, 1.5, 3.56);
        this.group.add(plate);
    }

    /* ========================================================
     *  UPDATE
     * ======================================================== */
    update(dt, playerPos) {
        if (!this.alive) return;

        if (this.subType === 'tani_oh') {
            this._updateTaniOh(dt, playerPos);
        } else {
            this._updateDiCokka(dt, playerPos);
        }

        // フラッシュ回復
        if (this.flashTimer > 0) {
            this.flashTimer -= dt;
            if (this.flashTimer <= 0) {
                const baseColor = this.subType === 'tani_oh' ? 0x47777C : 0x6F8E88;
                this._setColor(this.hullMesh, baseColor);
            }
        }

        // 弾丸更新
        this.projectiles.forEach(p => p.update(dt));
        this.projectiles = this.projectiles.filter(p => p.alive || p.impactPending);

        // ダメージ煙トレイル
        this._updateDamageSmoke(dt);
    }

    _updateDamageSmoke(dt) {
        const hpRatio = this.hp / this.maxHp;
        if (hpRatio < 0.5 && this.alive) {
            // 低HPほど頻繁に
            const interval = hpRatio < 0.2 ? 0.08 : (hpRatio < 0.35 ? 0.16 : 0.28);
            this.smokeTimer += dt;
            if (this.smokeTimer >= interval) {
                this.smokeTimer = 0;
                this._spawnSmokePuff(hpRatio);
            }
        }
        // パフ更新
        for (let i = this.smokePuffs.length - 1; i >= 0; i--) {
            const p = this.smokePuffs[i];
            p.age += dt;
            const t = p.age / p.maxAge;
            if (t >= 1) {
                this.scene.remove(p.mesh);
                p.mesh.geometry.dispose();
                p.mesh.material.dispose();
                this.smokePuffs.splice(i, 1);
                continue;
            }
            p.mesh.position.x += p.vx * dt;
            p.mesh.position.y += p.vy * dt;
            p.mesh.position.z += p.vz * dt;
            p.vy += 1.6 * dt; // 上昇加速
            const s = p.startScale + t * 1.6;
            p.mesh.scale.setScalar(s);
            p.mesh.material.opacity = (1 - t) * p.startOpacity;
        }
    }

    _spawnSmokePuff(hpRatio) {
        const isAir = this.subType === 'tani_oh';
        // ボス上の煙発生点（複数候補からランダム）
        const localOffsets = isAir
            ? [[-3, 1.0, -2], [-3, 1.0, 2], [-1, 2.0, 0], [2, 1.5, 1.5]]
            : [[-3.5, 3.5, 0], [0, 4.6, 0.8], [-1.5, 5.0, -0.3], [-2, 4.0, 1.5]];
        const off = localOffsets[Math.floor(Math.random() * localOffsets.length)];
        const localPos = new THREE.Vector3(off[0], off[1], off[2]);
        const worldPos = this.group.localToWorld(localPos.clone());
        worldPos.x += (Math.random() - 0.5) * 0.6;
        worldPos.z += (Math.random() - 0.5) * 0.6;

        // 黒煙〜濃灰、低HPでは火の粉混じり
        const isFireTinge = hpRatio < 0.25 && Math.random() < 0.35;
        const color = isFireTinge ? 0xFF7820 : (Math.random() < 0.3 ? 0x222222 : 0x4A4540);
        const puff = new THREE.Mesh(
            new THREE.SphereGeometry(0.5, 8, 6),
            new THREE.MeshBasicMaterial({
                color, transparent: true,
                opacity: 0.7, depthWrite: false,
                blending: isFireTinge ? THREE.AdditiveBlending : THREE.NormalBlending,
            })
        );
        puff.position.copy(worldPos);
        const startScale = 0.7 + Math.random() * 0.4;
        puff.scale.setScalar(startScale);
        this.scene.add(puff);
        this.smokePuffs.push({
            mesh: puff,
            age: 0,
            maxAge: 1.4 + Math.random() * 0.6,
            vx: (Math.random() - 0.5) * 1.5,
            vy: 1.0 + Math.random() * 1.5,
            vz: (Math.random() - 0.5) * 1.5,
            startScale,
            startOpacity: isFireTinge ? 0.85 : 0.7,
        });
    }

    _updateDiCokka(dt, playerPos) {
        // 砲塔をプレイヤーに向ける（ローカル空間: 親グループの baseline 回転を差し引く）
        if (this.turretGroup && playerPos && !this.turretDestroyed) {
            const turretWorldPos = new THREE.Vector3();
            this.turretGroup.getWorldPosition(turretWorldPos);
            const dir = new THREE.Vector3().subVectors(playerPos, turretWorldPos);
            dir.y = 0;
            if (dir.lengthSq() > 0.1) {
                const worldAngle = Math.atan2(-dir.z, dir.x);
                const targetLocal = worldAngle - this.group.rotation.y;
                this.turretGroup.rotation.y += (targetLocal - this.turretGroup.rotation.y) * 0.05;
            }
        }

        // 登場移動（前方から後退して targetZ に近づく）
        if (!this.entryComplete) {
            if (this.group.position.z > this.targetZ) {
                this.group.position.z -= this.speed * dt;
            } else {
                this.entryComplete = true;
            }
            return;
        }

        // 突進攻撃（-Z 方向へプレイヤーに接近）
        if (this.charging) {
            this.chargeTimer -= dt;
            this.group.position.z -= this.chargeSpeed * dt;
            if (this.chargeTimer <= 0 || this.group.position.z < playerPos.z - 15) {
                this.charging = false;
                this.targetZ = playerPos.z + 15 + Math.random() * 10;
            }
        } else {
            // ゆっくり所定位置に戻る
            const diff = this.targetZ - this.group.position.z;
            if (Math.abs(diff) > 1) {
                this.group.position.z += Math.sign(diff) * this.speed * 0.5 * dt;
            }
        }

        // 攻撃タイマー
        this.attackTimer += dt;
        if (this.attackTimer >= this.attackCooldown && playerPos) {
            this.attackTimer = 0;
            this._executeDiCokkaAttack(playerPos);
        }

        // バースト射撃
        if (this.burstCount > 0) {
            this.burstTimer -= dt;
            if (this.burstTimer <= 0 && playerPos) {
                this.burstTimer = 0.08;
                this.burstCount--;
                this._fireMG(playerPos);
            }
        }
    }

    _updateTaniOh(dt, playerPos) {
        // ホバリング（上下にゆっくり揺れる）
        this.bobPhase += dt * 1.5;
        const bobY = Math.sin(this.bobPhase) * 1.0;

        // 砲塔をプレイヤーに向ける（ローカル空間: baseline 回転を差し引く）
        if (this.turretGroup && playerPos && !this.turretDestroyed) {
            const turretWorldPos = new THREE.Vector3();
            this.turretGroup.getWorldPosition(turretWorldPos);
            const dir = new THREE.Vector3().subVectors(playerPos, turretWorldPos);
            if (dir.lengthSq() > 0.1) {
                const worldAngle = Math.atan2(-dir.z, dir.x);
                const targetLocal = worldAngle - this.group.rotation.y;
                this.turretGroup.rotation.y += (targetLocal - this.turretGroup.rotation.y) * 0.04;
            }
        }

        // 砲口の光パルス
        if (this.muzzleGlow) {
            this.muzzleGlow.material.opacity = 0.3 + Math.sin(this.bobPhase * 3) * 0.3;
        }

        // エネルギーコア脈動
        const corePulse = 0.7 + Math.sin(this.bobPhase * 4) * 0.3;
        if (this.energyCore) {
            this.energyCore.material.opacity = corePulse * 0.95;
            const s = 0.9 + Math.sin(this.bobPhase * 4) * 0.1;
            this.energyCore.scale.setScalar(s);
        }
        if (this.energyHalo) {
            this.energyHalo.material.opacity = 0.15 + corePulse * 0.18;
        }

        // スラスター炎の脈動・スケール
        if (this.thrusterCones) {
            const flicker = 0.85 + Math.sin(this.bobPhase * 18) * 0.1 + (Math.random() - 0.5) * 0.06;
            this.thrusterCones.forEach(c => {
                c.scale.x = flicker;
                c.material.opacity = 0.55 + Math.sin(this.bobPhase * 12) * 0.2;
            });
        }
        if (this.thrusterGlows) {
            this.thrusterGlows.forEach(g => {
                g.material.opacity = 0.8 + Math.sin(this.bobPhase * 14) * 0.15;
            });
        }
        if (this.ductFans) {
            this.ductFans.forEach((fan, idx) => {
                fan.rotation.z += dt * (idx % 2 === 0 ? 5.5 : -5.5);
            });
        }

        // ホバーリング（脈動）
        if (this.hoverRing) {
            this.hoverRing.material.opacity = 0.12 + Math.sin(this.bobPhase * 2) * 0.08;
            this.hoverRing.rotation.z += dt * 0.4;
        }

        // 登場移動（前方から -Z 方向に後退して targetZ に近づく）
        if (!this.entryComplete) {
            if (this.group.position.z > this.targetZ) {
                this.group.position.z -= this.speed * dt;
            } else {
                this.entryComplete = true;
            }
            this.group.position.y = 8 + bobY;
            return;
        }

        // フェーズに応じた行動
        const hpRatio = this.hp / this.maxHp;
        if (hpRatio < 0.3 && this.phase < 3) {
            this.phase = 3;
            this.attackCooldown = 1.2;
        } else if (hpRatio < 0.6 && this.phase < 2) {
            this.phase = 2;
            this.attackCooldown = 2.0;
        }

        // 移動パターン（フェーズ別）— 左右に X 揺らしつつ、Z でプレイヤー前方をキープ
        if (this.phase >= 3) {
            // 激しく左右に動く
            const targetX = playerPos.x + Math.sin(this.bobPhase * 0.7) * 12;
            const diffX = targetX - this.group.position.x;
            this.group.position.x += Math.sign(diffX) * Math.min(Math.abs(diffX), this.speed * 1.5 * dt);

            const targetZ = playerPos.z + 14;
            const diffZ = targetZ - this.group.position.z;
            this.group.position.z += Math.sign(diffZ) * Math.min(Math.abs(diffZ), this.speed * 0.8 * dt);
            this.group.position.y = 6 + bobY + Math.sin(this.bobPhase * 2) * 1.5;
        } else if (this.phase >= 2) {
            const targetX = playerPos.x + Math.sin(this.bobPhase * 0.5) * 8;
            const diffX = targetX - this.group.position.x;
            this.group.position.x += Math.sign(diffX) * Math.min(Math.abs(diffX), this.speed * dt);

            const targetZ = playerPos.z + 18;
            const diffZ = targetZ - this.group.position.z;
            this.group.position.z += Math.sign(diffZ) * Math.min(Math.abs(diffZ), this.speed * 0.6 * dt);
            this.group.position.y = 7 + bobY;
        } else {
            const diff = this.targetZ - this.group.position.z;
            if (Math.abs(diff) > 1) {
                this.group.position.z += Math.sign(diff) * this.speed * 0.5 * dt;
            }
            this.group.position.y = 8 + bobY;
        }

        // 攻撃タイマー
        this.attackTimer += dt;
        if (this.attackTimer >= this.attackCooldown && playerPos) {
            this.attackTimer = 0;
            this._executeTaniOhAttack(playerPos);
        }

        // バースト射撃
        if (this.burstCount > 0) {
            this.burstTimer -= dt;
            if (this.burstTimer <= 0 && playerPos) {
                this.burstTimer = 0.12;
                this.burstCount--;
                this._fireTaniOhSub(playerPos);
            }
        }
    }

    /* ========================================================
     *  ATTACKS - Di-Cokka
     * ======================================================== */
    _executeDiCokkaAttack(playerPos) {
        const hpRatio = this.hp / this.maxHp;
        const roll = Math.random();

        if (hpRatio < 0.25 && roll < 0.35) {
            // 突進攻撃
            this.charging = true;
            this.chargeTimer = 2.5;
        } else if (!this.turretDestroyed && roll < 0.5) {
            // 主砲発射
            this._fireMainCannon(playerPos);
        } else if (!this.armorDestroyed && roll < 0.7) {
            // ミサイル斉射
            this._fireMissileBarrage(playerPos);
        } else {
            // 機銃バースト
            this.burstCount = 8 + Math.floor(Math.random() * 8);
            this.burstTimer = 0;
        }

        this.attackCooldown = hpRatio < 0.4 ? 1.5 : 2.5;
    }

    _fireMainCannon(playerPos) {
        if (this.turretDestroyed) return;
        const turretWorldPos = new THREE.Vector3();
        this.turretGroup.getWorldPosition(turretWorldPos);
        const dir = new THREE.Vector3().subVectors(playerPos, turretWorldPos);
        dir.y = 0.05;
        dir.normalize();

        // 砲塔の向きに対する水平垂直方向（左右砲身のオフセット用）
        const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();

        for (let side of [-0.5, 0.5]) {
            const muzzlePos = turretWorldPos.clone()
                .addScaledVector(dir, 4.5)
                .addScaledVector(perp, side);
            muzzlePos.y += 0.4;

            const shell = new Projectile(this.scene, {
                position: muzzlePos,
                direction: dir.clone(),
                speed: 28,
                damage: 30,
                owner: 'enemy',
                type: 'cannon',
                maxDistance: 100,
            });
            this.projectiles.push(shell);
            this._spawnEffect(new Explosion(this.scene, muzzlePos, { type: 'muzzle', color: 0xFF6600 }));
        }
    }

    _fireMissileBarrage(playerPos) {
        // サイドミサイルポッドから4発（車体ローカル座標をワールドへ変換）
        this._attackTimers = this._attackTimers || [];
        for (let i = 0; i < 4; i++) {
            const tid = setTimeout(() => {
                this._attackTimers && this._attackTimers.splice(this._attackTimers.indexOf(tid), 1);
                if (!this.alive) return;
                const localOffset = new THREE.Vector3(
                    1.0 + (i % 2) * 0.5,
                    3.0,
                    (i < 2 ? -3.2 : 3.2)
                );
                const muzzlePos = this.group.localToWorld(localOffset);
                const dir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
                dir.y += 2; // 上に弧を描く
                dir.normalize();

                const missile = new Projectile(this.scene, {
                    position: muzzlePos,
                    direction: dir,
                    speed: 18,
                    damage: 20,
                    owner: 'enemy',
                    type: 'rocket',
                    maxDistance: 80,
                    gravity: 3,
                });
                this.projectiles.push(missile);
                this._spawnEffect(new Explosion(this.scene, muzzlePos, { type: 'muzzle', color: 0xFF4400 }));
            }, i * 150);
            this._attackTimers.push(tid);
        }
    }

    /* ========================================================
     *  ATTACKS - Tani Oh
     * ======================================================== */
    _executeTaniOhAttack(playerPos) {
        const roll = Math.random();

        if (this.phase >= 3) {
            // フェーズ3: 全攻撃をランダムに
            if (roll < 0.3) this._fireTaniOhMainCannon(playerPos);
            else if (roll < 0.6) this._fireTaniOhMissiles(playerPos);
            else {
                this.burstCount = 12;
                this.burstTimer = 0;
            }
        } else if (this.phase >= 2) {
            if (roll < 0.4 && !this.turretDestroyed) this._fireTaniOhMainCannon(playerPos);
            else if (roll < 0.7) this._fireTaniOhMissiles(playerPos);
            else {
                this.burstCount = 8;
                this.burstTimer = 0;
            }
        } else {
            if (roll < 0.5 && !this.turretDestroyed) this._fireTaniOhMainCannon(playerPos);
            else {
                this.burstCount = 6;
                this.burstTimer = 0;
            }
        }
    }

    _fireTaniOhMainCannon(playerPos) {
        if (this.turretDestroyed) return;
        const turretWorldPos = new THREE.Vector3();
        this.turretGroup.getWorldPosition(turretWorldPos);
        const dir = new THREE.Vector3().subVectors(playerPos, turretWorldPos);
        dir.normalize();

        const muzzlePos = turretWorldPos.clone();
        muzzlePos.x += dir.x * 5;
        muzzlePos.y += dir.y * 5;
        muzzlePos.z += dir.z * 5;

        // 大型砲弾
        const shell = new Projectile(this.scene, {
            position: muzzlePos,
            direction: dir,
            speed: 22,
            damage: 35,
            owner: 'enemy',
            type: 'cannon',
            maxDistance: 120,
        });
        this.projectiles.push(shell);
        this._spawnEffect(new Explosion(this.scene, muzzlePos, { type: 'muzzle', color: 0x44DDFF }));

        // 砲口フラッシュ
        if (this.muzzleGlow) {
            this.muzzleGlow.material.opacity = 1.0;
        }
    }

    _fireTaniOhMissiles(playerPos) {
        this._attackTimers = this._attackTimers || [];
        for (let i = 0; i < 6; i++) {
            const tid = setTimeout(() => {
                this._attackTimers && this._attackTimers.splice(this._attackTimers.indexOf(tid), 1);
                if (!this.alive) return;
                const side = i < 3 ? -1 : 1;
                const localOffset = new THREE.Vector3(
                    -1 + (i % 3) * 0.6,
                    -0.8,
                    side * 5.8
                );
                const muzzlePos = this.group.localToWorld(localOffset);
                const dir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
                dir.y += 1;
                dir.normalize();

                const missile = new Projectile(this.scene, {
                    position: muzzlePos,
                    direction: dir,
                    speed: 15,
                    damage: 15,
                    owner: 'enemy',
                    type: 'rocket',
                    maxDistance: 80,
                    gravity: 4,
                });
                this.projectiles.push(missile);
            }, i * 120);
            this._attackTimers.push(tid);
        }
    }

    _fireTaniOhSub(playerPos) {
        const turretWorldPos = new THREE.Vector3();
        this.turretGroup.getWorldPosition(turretWorldPos);
        const dir = new THREE.Vector3().subVectors(playerPos, turretWorldPos);
        dir.x += (Math.random() - 0.5) * 0.2;
        dir.z += (Math.random() - 0.5) * 0.2;
        dir.normalize();

        const muzzlePos = turretWorldPos.clone();
        muzzlePos.x += dir.x * 2;
        muzzlePos.y += dir.y * 2;

        const bullet = new Projectile(this.scene, {
            position: muzzlePos,
            direction: dir,
            speed: 30,
            damage: 10,
            owner: 'enemy',
            type: 'bullet',
            maxDistance: 80,
        });
        this.projectiles.push(bullet);
    }

    /* ========================================================
     *  SHARED ATTACKS
     * ======================================================== */
    _fireMG(playerPos) {
        const turretWorldPos = new THREE.Vector3();
        this.turretGroup.getWorldPosition(turretWorldPos);
        const dir = new THREE.Vector3().subVectors(playerPos, turretWorldPos);
        dir.y = 0.05;
        dir.x += (Math.random() - 0.5) * 0.15;
        dir.z += (Math.random() - 0.5) * 0.15;
        dir.normalize();

        const muzzlePos = turretWorldPos.clone();
        muzzlePos.x += dir.x * 2;
        muzzlePos.z += dir.z * 2;
        muzzlePos.y += 1.0;

        const bullet = new Projectile(this.scene, {
            position: muzzlePos,
            direction: dir,
            speed: 35,
            damage: 8,
            owner: 'enemy',
            type: 'bullet',
            maxDistance: 80,
        });
        this.projectiles.push(bullet);
    }

    /* ========================================================
     *  DAMAGE
     * ======================================================== */
    takeDamage(amount) {
        if (!this.alive) return;
        this.hp -= amount;

        // フラッシュ
        this.flashTimer = 0.08;
        this._setColor(this.hullMesh, 0xFF4444);

        // パーツ破壊チェック
        if (!this.armorDestroyed && this.hp < this.maxHp * 0.6) {
            this.armorDestroyed = true;
            if (this.armorGroup) {
                this.armorGroup.visible = false;
                const pos = this.group.position.clone();
                pos.y += 2;
                this._spawnEffect(new Explosion(this.scene, pos, { type: 'large' }));
                // 追加爆発（リセット時にキャンセルできるよう _attackTimers に追跡）
                this._attackTimers = this._attackTimers || [];
                const tid = setTimeout(() => {
                    this._attackTimers && this._attackTimers.splice(this._attackTimers.indexOf(tid), 1);
                    if (!this.alive) return;
                    this._spawnEffect(new Explosion(this.scene, pos.clone().add(new THREE.Vector3(2, 1, -1)), { type: 'large' }));
                }, 200);
                this._attackTimers.push(tid);
            }
        }

        if (!this.turretDestroyed && this.hp < this.maxHp * 0.3) {
            this.turretDestroyed = true;
            if (this.turretMesh) {
                this.turretMesh.visible = false;
                if (this.barrelGroup) this.barrelGroup.visible = false;
            }
            const pos = this.group.position.clone();
            pos.y += this.subType === 'tani_oh' ? 0 : 4;
            this._spawnEffect(new Explosion(this.scene, pos, { type: 'large' }));
            this._attackTimers = this._attackTimers || [];
            const tid2 = setTimeout(() => {
                this._attackTimers && this._attackTimers.splice(this._attackTimers.indexOf(tid2), 1);
                if (!this.alive) return;
                this._spawnEffect(new Explosion(this.scene, pos.clone().add(new THREE.Vector3(-1, 2, 0.5)), { type: 'large' }));
            }, 300);
            this._attackTimers.push(tid2);
        }

        if (this.hp <= 0) {
            this.hp = 0;
            this.alive = false;
        }
    }

    _setColor(mesh, color) {
        if (mesh && mesh.material) {
            mesh.material.color.setHex(color);
        }
    }

    getPosition() {
        return this.group.position.clone();
    }

    /* ========================================================
     *  DESTROY
     * ======================================================== */
    destroy(effectsList = null) {
        const pos = this.group.position.clone();
        const explosionCount = this.subType === 'tani_oh' ? 10 : 7;
        // 引数で渡された effects list を一時的に使い、無ければ this.effectSink にフォールバック
        const sink = effectsList || this.effectSink || null;

        // 段階的な爆発カスケード — タイマー ID を保持してリセット時にキャンセル可
        this._destroyTimers = this._destroyTimers || [];
        for (let i = 0; i < explosionCount; i++) {
            const tid = setTimeout(() => {
                const offset = new THREE.Vector3(
                    (Math.random() - 0.5) * (this.subType === 'tani_oh' ? 10 : 6),
                    Math.random() * (this.subType === 'tani_oh' ? 5 : 4),
                    (Math.random() - 0.5) * (this.subType === 'tani_oh' ? 8 : 4)
                );
                const ex = new Explosion(this.scene, pos.clone().add(offset), {
                    type: 'large',
                    color: i % 3 === 0 ? 0xFF4400 : (i % 3 === 1 ? 0xFFAA00 : 0xFFFF44),
                    residueLife: 2.4,
                });
                if (sink && Array.isArray(sink)) {
                    sink.push(ex);
                } else {
                    this._spawnEffect(ex);
                }
            }, i * 180);
            this._destroyTimers.push(tid);
        }

        const finalTid = setTimeout(() => {
            this.scene.remove(this.group);
            this.group.traverse(child => {
                if (child.isMesh) {
                    child.geometry.dispose();
                    if (child.material.dispose) child.material.dispose();
                }
            });
            // 全タイマーが完了したのでクリア（メモリリーク防止）
            this._destroyTimers = [];
        }, explosionCount * 180 + 500);
        this._destroyTimers.push(finalTid);

        this.projectiles.forEach(p => p.destroy());
        this.projectiles = [];

        // 煙パフを片付け
        this.smokePuffs.forEach(p => {
            this.scene.remove(p.mesh);
            p.mesh.geometry.dispose();
            p.mesh.material.dispose();
        });
        this.smokePuffs = [];
    }

    /** 進行中の destroy カスケード + 攻撃ディレイをキャンセル（リセット時用）。
     *  攻撃 setTimeout は projectile / Explosion を生成するクロージャを保持する。
     *  リセット直後にこれが発火すると新ゲームに古いボスの弾やエフェクトが
     *  突然出現する原因になるため、まとめてキャンセルする。 */
    cancelDestroyTimers() {
        if (this._destroyTimers) {
            this._destroyTimers.forEach(t => clearTimeout(t));
            this._destroyTimers = [];
        }
        if (this._attackTimers) {
            this._attackTimers.forEach(t => clearTimeout(t));
            this._attackTimers = [];
        }
    }

    /** リセット用の即時破棄: 段階爆発を作らず、その場で scene/dispose だけ行う。
     *  R 連打時に古いボスの爆発カスケードが新ゲームに混入するのを防ぐ。 */
    destroyImmediate() {
        this.cancelDestroyTimers();
        this.alive = false;
        if (this.group && this.group.parent) {
            this.scene.remove(this.group);
        }
        this.group && this.group.traverse(child => {
            if (child.isMesh) {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                    else if (child.material.dispose) child.material.dispose();
                }
            }
        });
        this.projectiles.forEach(p => p.destroy && p.destroy());
        this.projectiles = [];
        if (this.smokePuffs) {
            this.smokePuffs.forEach(p => {
                if (p.mesh) {
                    this.scene.remove(p.mesh);
                    if (p.mesh.geometry) p.mesh.geometry.dispose();
                    if (p.mesh.material) p.mesh.material.dispose();
                }
            });
            this.smokePuffs = [];
        }
    }

    /**
     * 生成した Explosion エフェクトを effectSink に登録する。
     * 登録しない場合 update() が呼ばれず scene に永遠に残り
     * メタルスラッグが時間と共に重くなる主因となる。
     */
    _spawnEffect(effect) {
        if (!effect) return effect;
        if (this.effectSink && Array.isArray(this.effectSink)) {
            this.effectSink.push(effect);
        } else {
            // フォールバック: 最大寿命経過後に強制クリーンアップ
            setTimeout(() => {
                if (effect.alive && typeof effect.destroy === 'function') {
                    effect.destroy();
                }
            }, ((effect.maxAge || 1.0) * 1000) + 200);
        }
        return effect;
    }
}
