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
            hull:     0x607850,  // 鮮やかなオリーブドラブ
            hullDk:   0x3E5028,
            armor:    0x506840,
            metal:    0x707060,
            track:    0x282818,
            turret:   0x506840,
            cannon:   0x404048,
            red:      0xBB2020,
            light:    0xFFDD33,
            rust:     0x905A28,
            pipe:     0x606060,
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

        // ============ 装甲板グループ（破壊可能） ============
        this.armorGroup = new THREE.Group();

        // 前面追加装甲
        const extraArmor = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 2.0, 5.2),
            new THREE.MeshStandardMaterial({ color: C.armor, roughness: 0.5, metalness: 0.4 })
        );
        extraArmor.position.set(4.3, 2.2, 0);
        this.armorGroup.add(extraArmor);

        // サイドスカート（左右）
        for (let z of [-2.8, 2.8]) {
            const skirtGeo = new THREE.BoxGeometry(6.5, 1.2, 0.35);
            const skirt = new THREE.Mesh(skirtGeo, new THREE.MeshStandardMaterial({
                color: C.hullDk, roughness: 0.6, metalness: 0.3,
            }));
            skirt.position.set(0, 1.4, z);
            this.armorGroup.add(skirt);
        }

        // リベット（サイドスカート上）
        const rivetMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.4, metalness: 0.6 });
        for (let z of [-2.85, 2.85]) {
            for (let x = -2.5; x <= 2.5; x += 1.0) {
                const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.06, 4, 4), rivetMat);
                rivet.position.set(x, 1.9, z);
                this.armorGroup.add(rivet);
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

        // 二連主砲
        this.barrelGroup = new THREE.Group();
        for (let z of [-0.5, 0.5]) {
            // 砲身
            const barrelGeo = new THREE.CylinderGeometry(0.22, 0.28, 4.5, 8);
            const barrel = new THREE.Mesh(barrelGeo, new THREE.MeshStandardMaterial({
                color: C.cannon, roughness: 0.3, metalness: 0.6,
            }));
            barrel.rotation.z = Math.PI / 2;
            barrel.position.set(2.25, 0.4, z);
            this.barrelGroup.add(barrel);

            // マズルブレーキ
            const muzzle = new THREE.Mesh(
                new THREE.CylinderGeometry(0.35, 0.28, 0.5, 8),
                new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.3, metalness: 0.5 })
            );
            muzzle.rotation.z = Math.PI / 2;
            muzzle.position.set(4.6, 0.4, z);
            this.barrelGroup.add(muzzle);

            // 砲身リング
            for (let rx = 1.0; rx <= 3.5; rx += 1.2) {
                const ring = new THREE.Mesh(
                    new THREE.TorusGeometry(0.3, 0.03, 4, 8),
                    new THREE.MeshStandardMaterial({ color: C.metal, metalness: 0.5 })
                );
                ring.position.set(rx, 0.4, z);
                ring.rotation.y = Math.PI / 2;
                this.barrelGroup.add(ring);
            }
        }
        this.turretGroup.add(this.barrelGroup);

        // 同軸機銃
        this.mgBarrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.06, 0.08, 1.5, 6),
            new THREE.MeshStandardMaterial({ color: C.cannon, metalness: 0.5 })
        );
        this.mgBarrel.rotation.z = Math.PI / 2;
        this.mgBarrel.position.set(1.8, 1.0, 0);
        this.turretGroup.add(this.mgBarrel);

        // ペリスコープ
        const periscope = new THREE.Mesh(
            new THREE.BoxGeometry(0.2, 0.4, 0.15),
            new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.3, metalness: 0.5 })
        );
        periscope.position.set(0, 1.8, 0);
        this.turretGroup.add(periscope);

        this.group.add(this.turretGroup);

        // ============ 大型キャタピラ（左右） ============
        for (let side of [-1, 1]) {
            const trackGroup = new THREE.Group();

            // キャタピラ本体
            const trackGeo = new THREE.BoxGeometry(7.5, 1.6, 1.0);
            const track = new THREE.Mesh(trackGeo, new THREE.MeshStandardMaterial({
                color: C.track, roughness: 0.9, metalness: 0.2,
            }));
            track.position.set(0, 0.8, 0);
            trackGroup.add(track);

            // 転輪（6個）
            const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.25, 12);
            const wheelMat = new THREE.MeshStandardMaterial({
                color: C.metal, roughness: 0.4, metalness: 0.5,
            });
            for (let i = 0; i < 6; i++) {
                const wheel = new THREE.Mesh(wheelGeo, wheelMat);
                wheel.position.set(-3.0 + i * 1.2, 0.8, side * 0.2);
                wheel.rotation.x = Math.PI / 2;
                trackGroup.add(wheel);

                // ホイールハブ
                const hub = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.15, 0.15, 0.3, 6),
                    new THREE.MeshStandardMaterial({ color: C.rust, metalness: 0.4 })
                );
                hub.position.copy(wheel.position);
                hub.position.z += side * 0.15;
                hub.rotation.x = Math.PI / 2;
                trackGroup.add(hub);
            }

            // 誘導輪（前後）
            for (let x of [-3.5, 3.5]) {
                const guide = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.4, 0.4, 0.2, 10),
                    wheelMat
                );
                guide.position.set(x, 1.2, side * 0.15);
                guide.rotation.x = Math.PI / 2;
                trackGroup.add(guide);
            }

            // キャタピラ上面カバー
            const cover = new THREE.Mesh(
                new THREE.BoxGeometry(7.0, 0.15, 1.1),
                new THREE.MeshStandardMaterial({ color: C.hullDk, roughness: 0.7 })
            );
            cover.position.set(0, 1.65, 0);
            trackGroup.add(cover);

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

        // 赤い星マーク（車体側面）
        const starGeo = new THREE.CircleGeometry(0.5, 5);
        const starMat = new THREE.MeshStandardMaterial({
            color: C.red, side: THREE.DoubleSide,
        });
        for (let z of [-2.82, 2.82]) {
            const star = new THREE.Mesh(starGeo, starMat);
            star.position.set(0, 2.5, z);
            star.rotation.y = z > 0 ? 0 : Math.PI;
            this.group.add(star);
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
            body:     0x5A6080,  // 鮮やかなダークスチール
            bodyDk:   0x3A4058,
            armor:    0x4A5068,
            metal:    0x8088A0,
            engine:   0x383840,
            red:      0xCC2020,
            orange:   0xFF7700,
            light:    0x44EEFF,
            glass:    0x225588,
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
        for (let z of [-3, 3]) {
            const engineGroup = new THREE.Group();

            // エンジン本体
            const engineBody = new THREE.Mesh(
                new THREE.CylinderGeometry(0.8, 1.0, 2.5, 10),
                new THREE.MeshStandardMaterial({ color: C.engine, roughness: 0.4, metalness: 0.5 })
            );
            engineBody.rotation.z = Math.PI / 2;
            engineGroup.add(engineBody);

            // 排気口（光る）
            const exhaust = new THREE.Mesh(
                new THREE.CylinderGeometry(0.7, 0.6, 0.3, 10),
                new THREE.MeshBasicMaterial({ color: C.orange, transparent: true, opacity: 0.7 })
            );
            exhaust.rotation.z = Math.PI / 2;
            exhaust.position.x = -1.4;
            engineGroup.add(exhaust);

            // インテーク
            const intake = new THREE.Mesh(
                new THREE.CylinderGeometry(0.85, 0.9, 0.2, 10),
                new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.3, metalness: 0.6 })
            );
            intake.rotation.z = Math.PI / 2;
            intake.position.x = 1.3;
            engineGroup.add(intake);

            engineGroup.position.set(-4, 0, z);
            this.group.add(engineGroup);
        }

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
                const baseColor = this.subType === 'tani_oh' ? 0x5A5A6A : 0x5A6A4A;
                this._setColor(this.hullMesh, baseColor);
            }
        }

        // 弾丸更新
        this.projectiles.forEach(p => p.update(dt));
        this.projectiles = this.projectiles.filter(p => p.alive || p.impactPending);
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
            new Explosion(this.scene, muzzlePos, { type: 'muzzle', color: 0xFF6600 });
        }
    }

    _fireMissileBarrage(playerPos) {
        // サイドミサイルポッドから4発（車体ローカル座標をワールドへ変換）
        for (let i = 0; i < 4; i++) {
            setTimeout(() => {
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
                new Explosion(this.scene, muzzlePos, { type: 'muzzle', color: 0xFF4400 });
            }, i * 150);
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
        new Explosion(this.scene, muzzlePos, { type: 'muzzle', color: 0x44DDFF });

        // 砲口フラッシュ
        if (this.muzzleGlow) {
            this.muzzleGlow.material.opacity = 1.0;
        }
    }

    _fireTaniOhMissiles(playerPos) {
        for (let i = 0; i < 6; i++) {
            setTimeout(() => {
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
                new Explosion(this.scene, pos, { type: 'large' });
                // 追加爆発
                setTimeout(() => {
                    new Explosion(this.scene, pos.clone().add(new THREE.Vector3(2, 1, -1)), { type: 'large' });
                }, 200);
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
            new Explosion(this.scene, pos, { type: 'large' });
            setTimeout(() => {
                new Explosion(this.scene, pos.clone().add(new THREE.Vector3(-1, 2, 0.5)), { type: 'large' });
            }, 300);
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
    destroy() {
        const pos = this.group.position.clone();
        const explosionCount = this.subType === 'tani_oh' ? 10 : 7;

        for (let i = 0; i < explosionCount; i++) {
            setTimeout(() => {
                const offset = new THREE.Vector3(
                    (Math.random() - 0.5) * (this.subType === 'tani_oh' ? 10 : 6),
                    Math.random() * (this.subType === 'tani_oh' ? 5 : 4),
                    (Math.random() - 0.5) * (this.subType === 'tani_oh' ? 8 : 4)
                );
                new Explosion(this.scene, pos.clone().add(offset), {
                    type: 'large',
                    color: i % 3 === 0 ? 0xFF4400 : (i % 3 === 1 ? 0xFFAA00 : 0xFFFF44),
                });
            }, i * 180);
        }

        setTimeout(() => {
            this.scene.remove(this.group);
            this.group.traverse(child => {
                if (child.isMesh) {
                    child.geometry.dispose();
                    if (child.material.dispose) child.material.dispose();
                }
            });
        }, explosionCount * 180 + 500);

        this.projectiles.forEach(p => p.destroy());
        this.projectiles = [];
    }
}
