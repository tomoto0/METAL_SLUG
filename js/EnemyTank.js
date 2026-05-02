import * as THREE from 'three';
import { Enemy } from './Enemy.js';
import { Projectile } from './Projectile.js';

/**
 * 敵戦車
 * subType: 'light' | 'heavy' | 'flak' | 'siege'
 * 茶色/ダークグレー系、プレイヤー戦車より大きい
 */
export class EnemyTank extends Enemy {
    constructor(scene, {
        position,
        subType = 'light',
    }) {
        // Metal Slug 戦車スコア: Di-Cokka 相当の light=1500, heavy/Hairbuster 相当=3000
        // HP: キャノン 3〜4 発、もしくはバルカン連射で処理できる目安
        const SPECS = {
            light: { hp: 70,  speed: 2.0, scoreValue: 1500, fireRate: 2.0, damage: 15 },
            heavy: { hp: 140, speed: 1.0, scoreValue: 3000, fireRate: 1.5, damage: 20 },
            flak:  { hp: 120, speed: 1.35, scoreValue: 2600, fireRate: 0.95, damage: 8  },
            siege: { hp: 230, speed: 0.75, scoreValue: 4500, fireRate: 2.15, damage: 30 },
        };
        const spec = SPECS[subType] || SPECS.light;

        super(scene, { position, ...spec, type: 'tank' });
        this.subType = subType;

        // AI
        this.aiState = 'advance';
        this.attackRange = subType === 'siege' ? 36 : (subType === 'heavy' ? 30 : (subType === 'flak' ? 28 : 22));
        this.movePauseTimer = 0;
        this.movePhase = 'move'; // 'move' | 'pause'

        // 射程を通る導線（スポーン後最初の update で決定）
        this.crossTargetX = null;
        this.crossTargetZ = null;

        this._buildModel();
        this._recordMaterials();
        this.scene.add(this.group);
    }

    _buildModel() {
        const isHeavy = this.subType === 'heavy' || this.subType === 'siege' || this.subType === 'flak';
        const isSiege = this.subType === 'siege';
        const isFlak = this.subType === 'flak';
        const scale = isSiege ? 1.62 : (this.subType === 'heavy' ? 1.35 : (isFlak ? 1.18 : 1.0));

        const C = {
            hull:       isSiege ? 0x3B3E44 : (isFlak ? 0x4E5A4F : (isHeavy ? 0x4E5530 : 0x6A7548)),
            hullHi:     isSiege ? 0x777D86 : (isFlak ? 0x8EA07A : (isHeavy ? 0x8A9560 : 0xA0AA72)),
            hullDark:   isSiege ? 0x22262B : (isFlak ? 0x29382E : (isHeavy ? 0x2C321A : 0x3A4225)),
            turret:     isSiege ? 0x313640 : (isFlak ? 0x3E513F : (isHeavy ? 0x424A28 : 0x5A6438)),
            metal:      0x55584C,
            metalDk:    0x2A2C24,
            track:      0x16180F,
            trackInner: 0x0A0B07,
            rust:       0x7E4520,
            accent:     isSiege ? 0xE0A72A : (isFlak ? 0x2F9C64 : (isHeavy ? 0xC42818 : 0xC4A030)),
            light:      0xFFD860,
            mark:       0xE8C040,
            star:       0xC42020,
            ringW:      0xE8DEB4,
        };

        this.wheels = [];

        for (let side = -1; side <= 1; side += 2) {
            const pod = new THREE.Group();

            const trackOuter = new THREE.Mesh(
                new THREE.BoxGeometry(3.4 * scale, 1.02 * scale, 0.62 * scale),
                new THREE.MeshStandardMaterial({ color: C.track, roughness: 0.9, metalness: 0.2 })
            );
            trackOuter.position.y = 0.52 * scale;
            trackOuter.castShadow = true;
            pod.add(trackOuter);

            const trackInner = new THREE.Mesh(
                new THREE.BoxGeometry(3.0 * scale, 0.72 * scale, 0.44 * scale),
                new THREE.MeshStandardMaterial({ color: C.trackInner, roughness: 0.82, metalness: 0.18 })
            );
            trackInner.position.y = 0.52 * scale;
            pod.add(trackInner);

            // クローティース（外周）
            const trackBeltMat = new THREE.MeshStandardMaterial({ color: C.track, roughness: 0.95, metalness: 0.2 });
            const clawGeo = new THREE.BoxGeometry(0.16 * scale, 0.13 * scale, 0.7 * scale);
            for (let cx = -1.45; cx <= 1.45; cx += 0.22) {
                const top = new THREE.Mesh(clawGeo, trackBeltMat);
                top.position.set(cx * scale, 1.06 * scale, 0);
                pod.add(top);
                const bot = new THREE.Mesh(clawGeo, trackBeltMat);
                bot.position.set(cx * scale, -0.02 * scale, 0);
                pod.add(bot);
            }
            // 前後カーブ部のティース
            for (let i = 0; i < 5; i++) {
                const a = (i / 5) * Math.PI;
                for (let dir of [-1, 1]) {
                    const claw = new THREE.Mesh(clawGeo, trackBeltMat);
                    claw.position.set(
                        (dir * 1.55 + dir * Math.sin(a) * 0.12) * scale,
                        (0.52 + dir * Math.cos(a) * 0.55) * scale * (dir > 0 ? 1 : 1),
                        0
                    );
                    // simpler: just place along curve
                    const cx = dir * 1.55;
                    const cy = 0.52 + Math.cos(a) * 0.55 * dir;
                    claw.position.set(cx * scale, cy * scale, 0);
                    claw.rotation.z = dir * a;
                    pod.add(claw);
                }
            }

            const wheelMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.35, metalness: 0.55 });
            const mainWheelGeo = new THREE.CylinderGeometry(0.38 * scale, 0.38 * scale, 0.18 * scale, 12);
            const roadWheelGeo = new THREE.CylinderGeometry(0.24 * scale, 0.24 * scale, 0.15 * scale, 10);

            for (const x of [-1.22, 1.22]) {
                const wheel = new THREE.Mesh(mainWheelGeo, wheelMat);
                wheel.rotation.x = Math.PI / 2;
                wheel.position.set(x * scale, 0.5 * scale, 0);
                pod.add(wheel);
                this.wheels.push(wheel);
            }

            for (const x of [-0.55, 0, 0.55]) {
                const wheel = new THREE.Mesh(roadWheelGeo, wheelMat);
                wheel.rotation.x = Math.PI / 2;
                wheel.position.set(x * scale, 0.42 * scale, 0);
                pod.add(wheel);
                this.wheels.push(wheel);
            }

            const fender = new THREE.Mesh(
                new THREE.BoxGeometry(3.15 * scale, 0.08 * scale, 0.72 * scale),
                new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.72, metalness: 0.18 })
            );
            fender.position.y = 1.04 * scale;
            pod.add(fender);

            const skirt = new THREE.Mesh(
                new THREE.BoxGeometry(2.8 * scale, 0.34 * scale, 0.08 * scale),
                new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.62, metalness: 0.18 })
            );
            skirt.position.set(0, 0.92 * scale, side * 0.28 * scale);
            pod.add(skirt);

            pod.position.set(0, 0, side * 1.22 * scale);
            this.group.add(pod);
        }

        const belly = new THREE.Mesh(
            new THREE.SphereGeometry(1.38 * scale, 18, 14, 0, Math.PI * 2, Math.PI * 0.2, Math.PI * 0.48),
            new THREE.MeshStandardMaterial({ color: C.hull, roughness: 0.58, metalness: 0.16 })
        );
        belly.scale.set(1.15, 0.72, 0.84);
        belly.position.set(-0.05 * scale, 1.22 * scale, 0);
        belly.castShadow = true;
        this.group.add(belly);

        const upperHull = new THREE.Mesh(
            new THREE.BoxGeometry(2.95 * scale, 0.84 * scale, 2.15 * scale),
            new THREE.MeshStandardMaterial({ color: C.hull, roughness: 0.66, metalness: 0.2 })
        );
        upperHull.position.set(0, 1.62 * scale, 0);
        upperHull.castShadow = true;
        this.group.add(upperHull);

        const frontGlacis = new THREE.Mesh(
            new THREE.BoxGeometry(0.95 * scale, 0.78 * scale, 1.95 * scale),
            new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.52, metalness: 0.24 })
        );
        frontGlacis.position.set(1.48 * scale, 1.5 * scale, 0);
        frontGlacis.rotation.z = -0.24;
        this.group.add(frontGlacis);

        const hullHighlight = new THREE.Mesh(
            new THREE.BoxGeometry(1.95 * scale, 0.14 * scale, 1.7 * scale),
            new THREE.MeshStandardMaterial({ color: C.hullHi, roughness: 0.32, metalness: 0.12 })
        );
        hullHighlight.position.set(-0.08 * scale, 1.95 * scale, 0);
        this.group.add(hullHighlight);

        const rearDeck = new THREE.Mesh(
            new THREE.BoxGeometry(1.05 * scale, 0.18 * scale, 1.58 * scale),
            new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.45, metalness: 0.35 })
        );
        rearDeck.position.set(-1.1 * scale, 1.98 * scale, 0);
        this.group.add(rearDeck);

        for (const z of [-0.58, 0.58]) {
            const exhaust = new THREE.Mesh(
                new THREE.CylinderGeometry(0.08 * scale, 0.11 * scale, 0.56 * scale, 8),
                new THREE.MeshStandardMaterial({ color: C.rust, roughness: 0.78, metalness: 0.18 })
            );
            exhaust.position.set(-1.38 * scale, 1.72 * scale, z * scale);
            exhaust.rotation.z = Math.PI / 2 + 0.28;
            this.group.add(exhaust);
        }

        for (let x = -0.95; x <= 1.15; x += 0.35) {
            for (const z of [-0.88, 0.88]) {
                const rivet = new THREE.Mesh(
                    new THREE.SphereGeometry(0.04 * scale, 5, 4),
                    new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.3, metalness: 0.6 })
                );
                rivet.position.set(x * scale, 1.7 * scale, z * scale);
                this.group.add(rivet);
            }
        }

        for (const z of [-0.52, 0.52]) {
            const headlight = new THREE.Mesh(
                new THREE.SphereGeometry(0.1 * scale, 8, 6),
                new THREE.MeshStandardMaterial({
                    color: C.light,
                    emissive: C.light,
                    emissiveIntensity: 0.4,
                    roughness: 0.35,
                })
            );
            headlight.position.set(1.52 * scale, 1.34 * scale, z * scale);
            this.group.add(headlight);
        }

        this.turretGroup = new THREE.Group();
        this.turretGroup.position.set(0.14 * scale, 2.04 * scale, 0);

        const turretBase = new THREE.Mesh(
            new THREE.CylinderGeometry(0.9 * scale, 1.02 * scale, 0.28 * scale, 14),
            new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.58, metalness: 0.3 })
        );
        this.turretGroup.add(turretBase);

        const turretDome = new THREE.Mesh(
            new THREE.SphereGeometry(1.02 * scale, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.6),
            new THREE.MeshStandardMaterial({ color: C.turret, roughness: 0.5, metalness: 0.24 })
        );
        turretDome.scale.set(1.12, 0.72, 0.96);
        turretDome.position.y = 0.08 * scale;
        turretDome.castShadow = true;
        this.turretGroup.add(turretDome);

        const turretGlow = new THREE.Mesh(
            new THREE.BoxGeometry(1.2 * scale, 0.12 * scale, 0.98 * scale),
            new THREE.MeshStandardMaterial({ color: C.hullHi, roughness: 0.28, metalness: 0.12 })
        );
        turretGlow.position.set(0.08 * scale, 0.48 * scale, 0);
        this.turretGroup.add(turretGlow);

        const cupola = new THREE.Mesh(
            new THREE.CylinderGeometry(0.18 * scale, 0.22 * scale, 0.16 * scale, 10),
            new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.36, metalness: 0.42 })
        );
        cupola.position.set(-0.24 * scale, 0.56 * scale, 0);
        this.turretGroup.add(cupola);

        const barrelLen = isSiege ? 4.1 : (isHeavy ? 3.6 : 2.75);
        const barrelRadius = isSiege ? 0.18 : (isHeavy ? 0.15 : 0.11);
        const barrelMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.28, metalness: 0.66 });

        const recoilHousing = new THREE.Mesh(
            new THREE.CylinderGeometry((barrelRadius + 0.08) * scale, (barrelRadius + 0.08) * scale, 0.68 * scale, 10),
            barrelMat
        );
        recoilHousing.rotation.z = Math.PI / 2;
        recoilHousing.position.set(0.6 * scale, 0.18 * scale, 0);
        this.turretGroup.add(recoilHousing);

        this.barrel = new THREE.Mesh(
            new THREE.CylinderGeometry(barrelRadius * scale, (barrelRadius + 0.02) * scale, barrelLen * scale, 10),
            barrelMat
        );
        this.barrel.rotation.z = Math.PI / 2;
        this.barrel.position.set((barrelLen / 2 + 0.9) * scale, 0.18 * scale, 0);
        this.barrel.castShadow = true;
        this.turretGroup.add(this.barrel);

        // マズルブレーキ二段
        const muzzleOuter = new THREE.Mesh(
            new THREE.CylinderGeometry((barrelRadius + 0.08) * scale, (barrelRadius + 0.04) * scale, 0.32 * scale, 10),
            barrelMat
        );
        muzzleOuter.rotation.z = Math.PI / 2;
        muzzleOuter.position.set((barrelLen + 0.82) * scale, 0.18 * scale, 0);
        this.turretGroup.add(muzzleOuter);

        const muzzleTip = new THREE.Mesh(
            new THREE.CylinderGeometry((barrelRadius + 0.04) * scale, (barrelRadius + 0.10) * scale, 0.22 * scale, 10),
            barrelMat
        );
        muzzleTip.rotation.z = Math.PI / 2;
        muzzleTip.position.set((barrelLen + 1.05) * scale, 0.18 * scale, 0);
        this.turretGroup.add(muzzleTip);

        // ベントスリット
        for (const s of [-Math.PI / 2, Math.PI / 2]) {
            const slit = new THREE.Mesh(
                new THREE.BoxGeometry(0.22 * scale, 0.04 * scale, 0.08 * scale),
                new THREE.MeshBasicMaterial({ color: 0x080808 })
            );
            slit.position.set(
                (barrelLen + 0.82) * scale,
                0.18 * scale + Math.sin(s) * 0.15 * scale,
                Math.cos(s) * 0.15 * scale
            );
            slit.rotation.x = s;
            this.turretGroup.add(slit);
        }

        for (const x of [0.95, 1.45, 1.95]) {
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry((barrelRadius + 0.02) * scale, 0.02 * scale, 6, 10),
                new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.35, metalness: 0.5 })
            );
            ring.rotation.y = Math.PI / 2;
            ring.position.set(x * scale, 0.18 * scale, 0);
            this.turretGroup.add(ring);
        }

        if (isHeavy) {
            const sidePod = new THREE.Mesh(
                new THREE.BoxGeometry(0.82 * scale, 0.34 * scale, 1.55 * scale),
                new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.58, metalness: 0.22 })
            );
            sidePod.position.set(-0.22 * scale, 0.18 * scale, 0);
            this.turretGroup.add(sidePod);

            const coax = new THREE.Mesh(
                new THREE.CylinderGeometry(0.04 * scale, 0.04 * scale, 0.9 * scale, 6),
                barrelMat
            );
            coax.rotation.z = Math.PI / 2;
            coax.position.set(1.12 * scale, 0.42 * scale, 0.42 * scale);
            this.turretGroup.add(coax);

            // === 重戦車のみ: 砲塔側面ロケットポッド（アーティラリー仕様） ===
            const podMat = new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.6, metalness: 0.3 });
            const subBarrelMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.32, metalness: 0.6 });
            for (const sz of [-1, 1]) {
                // 角柱マウント
                const mount = new THREE.Mesh(
                    new THREE.BoxGeometry(0.7 * scale, 0.38 * scale, 0.3 * scale),
                    podMat
                );
                mount.position.set(0.2 * scale, 0.05 * scale, sz * 0.95 * scale);
                this.turretGroup.add(mount);
                // 二連装小口径砲
                for (const dy of [-0.08, 0.08]) {
                    const sb = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.06 * scale, 0.07 * scale, 1.5 * scale, 8),
                        subBarrelMat
                    );
                    sb.rotation.z = Math.PI / 2;
                    sb.position.set(1.05 * scale, 0.05 * scale + dy * scale, sz * 0.95 * scale);
                    this.turretGroup.add(sb);
                    // マズル
                    const mz = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.09 * scale, 0.07 * scale, 0.16 * scale, 8),
                        subBarrelMat
                    );
                    mz.rotation.z = Math.PI / 2;
                    mz.position.set(1.78 * scale, 0.05 * scale + dy * scale, sz * 0.95 * scale);
                    this.turretGroup.add(mz);
                }
            }

            // アンテナ（後部）
            const antenna = new THREE.Mesh(
                new THREE.CylinderGeometry(0.012 * scale, 0.018 * scale, 1.4 * scale, 6),
                subBarrelMat
            );
            antenna.position.set(-0.55 * scale, 0.85 * scale, 0.45 * scale);
            antenna.rotation.z = -0.18;
            this.turretGroup.add(antenna);
            // アンテナ先端の旗
            const flag = new THREE.Mesh(
                new THREE.PlaneGeometry(0.32 * scale, 0.18 * scale),
                new THREE.MeshStandardMaterial({ color: C.star, side: THREE.DoubleSide, roughness: 0.7 })
            );
            flag.position.set(-0.42 * scale, 1.5 * scale, 0.45 * scale);
            this.turretGroup.add(flag);
        }

        if (isFlak) {
            const flakMat = new THREE.MeshStandardMaterial({ color: C.metalDk, roughness: 0.38, metalness: 0.68 });
            const rackMat = new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.55, metalness: 0.35 });
            for (const sz of [-1, 1]) {
                const rack = new THREE.Mesh(new THREE.BoxGeometry(0.58 * scale, 0.28 * scale, 0.36 * scale), rackMat);
                rack.position.set(0.18 * scale, 0.60 * scale, sz * 0.72 * scale);
                this.turretGroup.add(rack);
                for (const dy of [-0.08, 0.08]) {
                    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.045 * scale, 0.05 * scale, 1.55 * scale, 8), flakMat);
                    barrel.rotation.z = Math.PI / 2;
                    barrel.position.set(1.06 * scale, 0.62 * scale + dy * scale, sz * 0.72 * scale);
                    barrel.rotation.y = sz * 0.05;
                    this.turretGroup.add(barrel);
                }
            }
            const radar = new THREE.Mesh(new THREE.CylinderGeometry(0.42 * scale, 0.08 * scale, 0.14 * scale, 14), flakMat);
            radar.position.set(-0.38 * scale, 0.94 * scale, 0);
            radar.rotation.z = -0.45;
            this.turretGroup.add(radar);
        }

        if (isSiege) {
            const slabMat = new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.62, metalness: 0.38 });
            const missileMat = new THREE.MeshStandardMaterial({ color: 0x5E5A42, roughness: 0.5, metalness: 0.35 });
            const tipMat = new THREE.MeshStandardMaterial({ color: 0xC42E20, roughness: 0.45, metalness: 0.22 });

            const rearPod = new THREE.Mesh(new THREE.BoxGeometry(1.15 * scale, 0.62 * scale, 1.62 * scale), slabMat);
            rearPod.position.set(-0.76 * scale, 0.46 * scale, 0);
            this.turretGroup.add(rearPod);

            for (const sz of [-0.48, 0, 0.48]) {
                const missile = new THREE.Mesh(new THREE.CylinderGeometry(0.07 * scale, 0.07 * scale, 0.9 * scale, 8), missileMat);
                missile.rotation.z = Math.PI / 2;
                missile.position.set(-0.18 * scale, 0.74 * scale, sz * scale);
                this.turretGroup.add(missile);
                const tip = new THREE.Mesh(new THREE.ConeGeometry(0.07 * scale, 0.18 * scale, 8), tipMat);
                tip.rotation.z = -Math.PI / 2;
                tip.position.set(0.36 * scale, 0.74 * scale, sz * scale);
                this.turretGroup.add(tip);
            }

            for (const z of [-1.08, 1.08]) {
                const plate = new THREE.Mesh(new THREE.BoxGeometry(2.8 * scale, 0.26 * scale, 0.12 * scale), slabMat);
                plate.position.set(-0.1 * scale, 1.95 * scale, z * scale);
                plate.rotation.z = 0.05;
                this.group.add(plate);
            }
        }

        const accent = new THREE.Mesh(
            new THREE.BoxGeometry(0.08 * scale, 0.22 * scale, 0.92 * scale),
            new THREE.MeshStandardMaterial({ color: C.accent, roughness: 0.52, metalness: 0.1 })
        );
        accent.position.set(0.42 * scale, 0.22 * scale, 0);
        this.turretGroup.add(accent);

        // 反乱軍エンブレム: 下向き赤三角 ▽（Metal Slug Rebel Army 公式マーク）
        const triShape = new THREE.Shape();
        const triR = 0.30 * scale;
        triShape.moveTo(-triR * 0.866, triR * 0.5);
        triShape.lineTo(triR * 0.866, triR * 0.5);
        triShape.lineTo(0, -triR);
        triShape.closePath();
        const triGeo = new THREE.ShapeGeometry(triShape);
        const triMat = new THREE.MeshStandardMaterial({
            color: C.star, side: THREE.DoubleSide, roughness: 0.55,
            emissive: 0x361010, emissiveIntensity: 0.22,
        });
        const discMat = new THREE.MeshBasicMaterial({ color: C.ringW, side: THREE.DoubleSide });
        const ringMat = new THREE.MeshStandardMaterial({
            color: C.hullDark, side: THREE.DoubleSide, roughness: 0.7, metalness: 0.2
        });
        for (const z of [-1.0, 1.0]) {
            // 白い円盤の台座
            const disc = new THREE.Mesh(
                new THREE.CircleGeometry(0.42 * scale, 22),
                discMat
            );
            disc.position.set(-0.15 * scale, 0.15 * scale, z * scale);
            disc.rotation.y = z > 0 ? 0 : Math.PI;
            this.turretGroup.add(disc);

            // 暗い縁取り
            const ring = new THREE.Mesh(
                new THREE.RingGeometry(0.41 * scale, 0.46 * scale, 22),
                ringMat
            );
            ring.position.set(-0.15 * scale, 0.15 * scale, (z + (z > 0 ? -0.002 : 0.002)) * scale);
            ring.rotation.y = z > 0 ? 0 : Math.PI;
            this.turretGroup.add(ring);

            // 赤三角
            const tri = new THREE.Mesh(triGeo, triMat);
            tri.position.set(-0.15 * scale, 0.15 * scale, (z + (z > 0 ? 0.005 : -0.005)) * scale);
            tri.rotation.y = z > 0 ? 0 : Math.PI;
            this.turretGroup.add(tri);
        }

        // 前面装甲のミニエンブレム
        const frontDisc = new THREE.Mesh(
            new THREE.CircleGeometry(0.22 * scale, 18),
            discMat
        );
        frontDisc.position.set(1.97 * scale, 1.78 * scale, 0);
        frontDisc.rotation.y = Math.PI / 2;
        this.group.add(frontDisc);
        const frontTri = new THREE.Mesh(
            (() => {
                const s = new THREE.Shape();
                const r = 0.16 * scale;
                s.moveTo(-r * 0.866, r * 0.5);
                s.lineTo(r * 0.866, r * 0.5);
                s.lineTo(0, -r);
                s.closePath();
                return new THREE.ShapeGeometry(s);
            })(),
            triMat
        );
        frontTri.position.set(1.972 * scale, 1.78 * scale, 0);
        frontTri.rotation.y = Math.PI / 2;
        this.group.add(frontTri);

        // 危険ストライプ（前面装甲）
        const stripeYellow = new THREE.MeshBasicMaterial({ color: C.mark });
        const stripeBlack = new THREE.MeshBasicMaterial({ color: 0x18180E });
        for (let i = 0; i < 5; i++) {
            const isBlack = i % 2 === 0;
            const stripe = new THREE.Mesh(
                new THREE.PlaneGeometry(0.1 * scale, 0.45 * scale),
                isBlack ? stripeBlack : stripeYellow
            );
            stripe.position.set(1.96 * scale, 1.36 * scale, (-0.7 + i * 0.35) * scale);
            stripe.rotation.y = Math.PI / 2;
            stripe.rotation.x = -0.24;
            this.group.add(stripe);
        }

        // ハッチ（開いた状態 = 円盤を傾けて立てる）
        const hatch = new THREE.Mesh(
            new THREE.CylinderGeometry(0.18 * scale, 0.18 * scale, 0.04 * scale, 12),
            new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.5, metalness: 0.4 })
        );
        hatch.position.set(-0.45 * scale, 0.78 * scale, 0);
        hatch.rotation.z = Math.PI / 2.2;
        this.turretGroup.add(hatch);
        // ハッチのボルト
        for (let b = 0; b < 6; b++) {
            const ang = (b / 6) * Math.PI * 2;
            const bolt = new THREE.Mesh(
                new THREE.SphereGeometry(0.025 * scale, 4, 4),
                new THREE.MeshStandardMaterial({ color: 0x95956E, roughness: 0.4, metalness: 0.7 })
            );
            bolt.position.set(
                -0.45 * scale + Math.cos(ang) * 0.04 * scale,
                0.78 * scale + Math.sin(ang) * 0.14 * scale,
                Math.cos(ang) * 0.13 * scale
            );
            this.turretGroup.add(bolt);
        }

        // ============================================
        // 反乱軍指揮官（ハッチから上半身を出している）
        // ============================================
        this.commander = new THREE.Group();
        this.commander.position.set(-0.24 * scale, 0.7 * scale, 0);

        // 胴体（小さなオリーブ/タン軍服）
        const cmdrIsOfficer = this.subType === 'heavy' || this.subType === 'siege';
        const cmdrUniform = cmdrIsOfficer ? 0xCCB080 : 0x6B8840;
        const cmdrTorso = new THREE.Mesh(
            new THREE.BoxGeometry(0.22 * scale, 0.20 * scale, 0.24 * scale),
            new THREE.MeshStandardMaterial({ color: cmdrUniform, roughness: 0.8 })
        );
        cmdrTorso.position.y = 0.04 * scale;
        this.commander.add(cmdrTorso);

        // 肩章/ハーネス
        const harnessMat = new THREE.MeshStandardMaterial({ color: 0x4A3828, roughness: 0.85 });
        const harness = new THREE.Mesh(
            new THREE.BoxGeometry(0.23 * scale, 0.06 * scale, 0.25 * scale),
            harnessMat
        );
        harness.position.y = 0.10 * scale;
        this.commander.add(harness);

        // 首
        const cmdrNeck = new THREE.Mesh(
            new THREE.CylinderGeometry(0.05 * scale, 0.06 * scale, 0.06 * scale, 8),
            new THREE.MeshStandardMaterial({ color: 0xD0A878, roughness: 0.85 })
        );
        cmdrNeck.position.y = 0.16 * scale;
        this.commander.add(cmdrNeck);

        // 頭（肌色、Metal Slug 風大きめ）
        const cmdrHead = new THREE.Mesh(
            new THREE.SphereGeometry(0.13 * scale, 12, 10),
            new THREE.MeshStandardMaterial({ color: 0xF0CCA0, roughness: 0.75 })
        );
        cmdrHead.position.y = 0.27 * scale;
        cmdrHead.scale.set(1.05, 1.0, 0.95);
        this.commander.add(cmdrHead);

        // ヘルメット（または士官帽）
        if (cmdrIsOfficer) {
            // 赤い士官帽
            const capCrown = new THREE.Mesh(
                new THREE.CylinderGeometry(0.12 * scale, 0.12 * scale, 0.10 * scale, 14),
                new THREE.MeshStandardMaterial({ color: 0xCC3333, roughness: 0.6 })
            );
            capCrown.position.y = 0.36 * scale;
            this.commander.add(capCrown);
            const capBrim = new THREE.Mesh(
                new THREE.CylinderGeometry(0.16 * scale, 0.17 * scale, 0.018 * scale, 14),
                new THREE.MeshStandardMaterial({ color: 0x1c1208, roughness: 0.5 })
            );
            capBrim.position.y = 0.30 * scale;
            this.commander.add(capBrim);
            // 帽章（金）
            const capBadge = new THREE.Mesh(
                new THREE.CircleGeometry(0.04 * scale, 10),
                new THREE.MeshStandardMaterial({ color: 0xE8C040, metalness: 0.6, roughness: 0.35 })
            );
            capBadge.position.set(0.12 * scale, 0.36 * scale, 0);
            capBadge.rotation.y = Math.PI / 2;
            this.commander.add(capBadge);
        } else {
            const cmdrHelmet = new THREE.Mesh(
                new THREE.SphereGeometry(0.165 * scale, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62),
                new THREE.MeshStandardMaterial({ color: 0x5D7835, roughness: 0.55, metalness: 0.25 })
            );
            cmdrHelmet.position.y = 0.32 * scale;
            cmdrHelmet.scale.set(1.12, 0.95, 1.1);
            this.commander.add(cmdrHelmet);
            // ヘルメットバンド
            const cmdrBand = new THREE.Mesh(
                new THREE.TorusGeometry(0.15 * scale, 0.012 * scale, 6, 16),
                new THREE.MeshStandardMaterial({ color: 0x9A8A60, roughness: 0.75 })
            );
            cmdrBand.position.y = 0.31 * scale;
            cmdrBand.rotation.x = Math.PI / 2;
            cmdrBand.scale.set(1.05, 1.0, 0.65);
            this.commander.add(cmdrBand);
        }

        // 怒り眉
        const cmdrBrowMat = new THREE.MeshBasicMaterial({ color: 0x1a1208 });
        for (let side of [-1, 1]) {
            const brow = new THREE.Mesh(
                new THREE.BoxGeometry(0.012 * scale, 0.022 * scale, 0.045 * scale),
                cmdrBrowMat
            );
            brow.position.set(0.115 * scale, 0.30 * scale, side * 0.05 * scale);
            brow.rotation.x = side * -0.5;
            this.commander.add(brow);
        }

        // 目（小さな黒点）
        const cmdrEyeMat = new THREE.MeshBasicMaterial({ color: 0x101010 });
        for (let side of [-1, 1]) {
            const eye = new THREE.Mesh(
                new THREE.SphereGeometry(0.018 * scale, 6, 5),
                cmdrEyeMat
            );
            eye.position.set(0.124 * scale, 0.275 * scale, side * 0.05 * scale);
            this.commander.add(eye);
        }

        // 口（叫び）
        const cmdrMouth = new THREE.Mesh(
            new THREE.BoxGeometry(0.008 * scale, 0.025 * scale, 0.045 * scale),
            new THREE.MeshBasicMaterial({ color: 0x180404 })
        );
        cmdrMouth.position.set(0.125 * scale, 0.225 * scale, 0);
        this.commander.add(cmdrMouth);

        // 鼻
        const cmdrNose = new THREE.Mesh(
            new THREE.SphereGeometry(0.022 * scale, 6, 5),
            new THREE.MeshStandardMaterial({ color: 0xD0A878, roughness: 0.85 })
        );
        cmdrNose.position.set(0.135 * scale, 0.255 * scale, 0);
        cmdrNose.scale.set(0.85, 0.95, 0.7);
        this.commander.add(cmdrNose);

        // 重戦車のみ: 双眼鏡を構える
        if (cmdrIsOfficer) {
            const binMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5, metalness: 0.4 });
            for (let side of [-1, 1]) {
                const bin = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.025 * scale, 0.025 * scale, 0.08 * scale, 8),
                    binMat
                );
                bin.rotation.z = Math.PI / 2;
                bin.position.set(0.18 * scale, 0.27 * scale, side * 0.035 * scale);
                this.commander.add(bin);
            }
        }

        this.commander.castShadow = true;
        this.turretGroup.add(this.commander);

        this.group.add(this.turretGroup);
    }

    update(dt, playerPos, elapsedTime) {
        if (!this.alive) return;
        super.update(dt, playerPos, elapsedTime);

        const toPlayer = new THREE.Vector3().subVectors(playerPos, this.group.position);
        toPlayer.y = 0;
        const dist = toPlayer.length();
        const dirToPlayer = toPlayer.clone().normalize();

        // 初回: 導線ターゲットを設定 — 射程内を横切る位置を目標にする
        if (this.crossTargetX === null) {
            const side = this.group.position.x - playerPos.x;
            const crossSide = (side === 0 ? (Math.random() < 0.5 ? 1 : -1) : -Math.sign(side));
            this.crossTargetX = playerPos.x + crossSide * (5 + Math.random() * 4);
            const spawnAhead = this.group.position.z > playerPos.z;
            this.crossTargetZ = playerPos.z + (spawnAhead ? -4 : 10) + (Math.random() - 0.5) * 3;
        }

        const toCross = new THREE.Vector3(
            this.crossTargetX - this.group.position.x,
            0,
            this.crossTargetZ - this.group.position.z
        );
        const crossDist = toCross.length();
        const dirToCross = crossDist > 0.001 ? toCross.clone().normalize() : dirToPlayer.clone();

        // 砲塔をプレイヤー方向に向ける（車体回転を差し引いたローカル回転）
        const turretWorldAngle = Math.atan2(-dirToPlayer.z, dirToPlayer.x);
        this.turretGroup.rotation.y = turretWorldAngle - this.group.rotation.y;

        // 導線ターゲットに接近したら新しい横断点を引き直す
        if (crossDist < 3.0) {
            const side = this.group.position.x - playerPos.x;
            const crossSide = (side === 0 ? (Math.random() < 0.5 ? 1 : -1) : -Math.sign(side));
            this.crossTargetX = playerPos.x + crossSide * (6 + Math.random() * 4);
            this.crossTargetZ = playerPos.z + (Math.random() < 0.5 ? -5 : 10);
        }

        // --- 移動 & 射撃 AI ---
        if (this.subType === 'light') {
            this._aiLight(dt, dist, dirToCross, playerPos, elapsedTime);
        } else if (this.subType === 'flak') {
            this._aiFlak(dt, dist, dirToCross, playerPos, elapsedTime);
        } else if (this.subType === 'siege') {
            this._aiSiege(dt, dist, dirToCross, playerPos, elapsedTime);
        } else {
            this._aiHeavy(dt, dist, dirToCross, playerPos, elapsedTime);
        }

        // 転輪回転
        if (this.aiState === 'advance') {
            this.wheels.forEach(w => { w.rotation.y += dt * 5; });
        }
    }

    _aiLight(dt, dist, dirCross, playerPos, elapsed) {
        // 導線上を前進しながら停止→射撃→前進のリズム
        this.movePauseTimer += dt;
        const bodyAngle = Math.atan2(-dirCross.z, dirCross.x);
        this.group.rotation.y = bodyAngle;

        if (this.movePhase === 'move') {
            this.aiState = 'advance';
            this.group.position.add(dirCross.clone().multiplyScalar(this.speed * dt));
            if (dist < this.attackRange && this.movePauseTimer > 2.5) {
                this.movePhase = 'pause';
                this.movePauseTimer = 0;
            }
        } else {
            this.aiState = 'attack';
            // 停止中も少しだけ前進（完全停止しない）
            this.group.position.add(dirCross.clone().multiplyScalar(this.speed * 0.2 * dt));
            this._fireCannon(playerPos, elapsed);
            if (this.movePauseTimer > 1.5) {
                this.movePhase = 'move';
                this.movePauseTimer = 0;
            }
        }
    }

    _aiHeavy(dt, dist, dirCross, playerPos, elapsed) {
        // 常にゆっくり前進（導線に沿って射程を横断）しながら撃つ
        this.aiState = 'advance';
        this.group.position.add(dirCross.clone().multiplyScalar(this.speed * dt));
        const bodyAngle = Math.atan2(-dirCross.z, dirCross.x);
        this.group.rotation.y = bodyAngle;

        if (dist < this.attackRange) {
            this._fireCannon(playerPos, elapsed);
            if (this.subType === 'heavy') {
                this._fireSpread(playerPos, elapsed);
            }
        }
    }

    _aiFlak(dt, dist, dirCross, playerPos, elapsed) {
        // 対空/制圧戦車: 横断しながら短い多弾幕を作る。
        this.movePauseTimer += dt;
        const bodyAngle = Math.atan2(-dirCross.z, dirCross.x);
        this.group.rotation.y = bodyAngle;

        const moveScale = dist < this.attackRange ? 0.48 : 1.05;
        this.group.position.add(dirCross.clone().multiplyScalar(this.speed * moveScale * dt));

        if (dist < this.attackRange) {
            this.aiState = 'attack';
            if (elapsed - this.lastFireTime > this.fireRate) {
                this.lastFireTime = elapsed;
                this._fireFlakBurst(playerPos);
            }
        } else {
            this.aiState = 'advance';
        }
    }

    _aiSiege(dt, dist, dirCross, playerPos, elapsed) {
        // 攻城戦車: 停止砲撃と低速前進を交互に行い、範囲弾とミサイルを重ねる。
        this.movePauseTimer += dt;
        const bodyAngle = Math.atan2(-dirCross.z, dirCross.x);
        this.group.rotation.y = bodyAngle;

        if (this.movePhase === 'move') {
            this.aiState = 'advance';
            this.group.position.add(dirCross.clone().multiplyScalar(this.speed * dt));
            if (dist < this.attackRange && this.movePauseTimer > 2.2) {
                this.movePhase = 'pause';
                this.movePauseTimer = 0;
            }
        } else {
            this.aiState = 'attack';
            this.group.position.add(dirCross.clone().multiplyScalar(this.speed * 0.12 * dt));
            this._fireCannon(playerPos, elapsed);
            this._fireSiegeMissiles(playerPos, elapsed);
            if (this.movePauseTimer > 2.4) {
                this.movePhase = 'move';
                this.movePauseTimer = 0;
            }
        }
    }

    _fireCannon(playerPos, elapsed) {
        if (elapsed - this.lastFireTime < this.fireRate) return;
        this.lastFireTime = elapsed;

        const muzzlePos = this.group.position.clone();
        const heightScale = this.subType === 'siege' ? 1.75 : (this.subType === 'heavy' ? 1.4 : (this.subType === 'flak' ? 1.2 : 1.0));
        muzzlePos.y += 2.0 * heightScale;

        const dir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
        dir.y = 0;
        dir.normalize();

        const shell = new Projectile(this.scene, {
            position: muzzlePos,
            direction: dir,
            speed: 18,
            damage: this.damage,
            owner: 'enemy',
            type: 'cannon',
            maxDistance: 50,
        });
        this.projectiles.push(shell);
    }

    _fireFlakBurst(playerPos) {
        const muzzlePos = this.group.position.clone();
        muzzlePos.y += 2.25;
        const baseDir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
        baseDir.y = 0.08;
        baseDir.normalize();

        for (let i = 0; i < 6; i++) {
            const angle = (i - 2.5) * 0.055;
            const dir = baseDir.clone();
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const nx = dir.x * cos - dir.z * sin;
            const nz = dir.x * sin + dir.z * cos;
            dir.x = nx + (Math.random() - 0.5) * 0.035;
            dir.z = nz + (Math.random() - 0.5) * 0.035;
            dir.normalize();

            const bullet = new Projectile(this.scene, {
                position: muzzlePos.clone(),
                direction: dir,
                speed: 22,
                damage: this.damage,
                owner: 'enemy',
                type: 'bullet',
                maxDistance: 52,
            });
            this.projectiles.push(bullet);
        }
    }

    _fireSiegeMissiles(playerPos, elapsed) {
        if (elapsed - (this.lastMissileTime || 0) < 3.4) return;
        this.lastMissileTime = elapsed;

        const basePos = this.group.position.clone();
        basePos.y += 3.05;
        const baseDir = new THREE.Vector3().subVectors(playerPos, basePos);
        baseDir.y = 0.22;
        baseDir.normalize();

        for (const side of [-1, 0, 1]) {
            const dir = baseDir.clone();
            dir.x += side * 0.10 + (Math.random() - 0.5) * 0.04;
            dir.z -= side * 0.04;
            dir.normalize();
            const rocket = new Projectile(this.scene, {
                position: basePos.clone().add(new THREE.Vector3(0, 0, side * 0.55)),
                direction: dir,
                speed: 13,
                damage: Math.floor(this.damage * 0.75),
                owner: 'enemy',
                type: 'rocket',
                maxDistance: 66,
            });
            this.projectiles.push(rocket);
        }
    }

    _fireSpread(playerPos, elapsed) {
        // 3way散弾（メイン砲弾と同時に小弾）
        const muzzlePos = this.group.position.clone();
        muzzlePos.y += 2.8;

        const baseDir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
        baseDir.y = 0;
        baseDir.normalize();

        for (let angle of [-0.2, 0.2]) {
            const dir = baseDir.clone();
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const nx = dir.x * cos - dir.z * sin;
            const nz = dir.x * sin + dir.z * cos;
            dir.x = nx;
            dir.z = nz;

            const bullet = new Projectile(this.scene, {
                position: muzzlePos.clone(),
                direction: dir,
                speed: 14,
                damage: 8,
                owner: 'enemy',
                type: 'bullet',
                maxDistance: 40,
            });
            this.projectiles.push(bullet);
        }
    }
}
