import * as THREE from 'three';
import { Projectile } from './Projectile.js';
import { Explosion } from './Explosion.js';

/**
 * マルコ・ロッシ — 徒歩戦闘キャラクター
 * Player と同一インターフェース: getPosition(), takeDamage(), isInvincible(), projectiles
 */
export class Marco {
    constructor(scene, camera) {
        this.scene = scene;
        this.camera = camera;
        this.alive = true;
        this.hp = 1;
        this.maxHp = 1;
        this.dead = false;

        this.group = new THREE.Group();
        this._buildModel();
        this.scene.add(this.group);
        this.group.visible = false;

        this.speed = 14;
        this.projectiles = [];
        this.effects = [];
        this.walkPhase = 0;

        this.fireRate = 0.12;
        this.lastFireTime = 0;

        this.invincibleTimer = 0;
        this.invincibleDuration = 0.6;

        // HUD互換フィールド
        this.grenadeCount = 3;
        this.maxGrenades = 3;
        this.cannonCharging = false;
        this.cannonCharge = 0;
        this.cannonChargeMax = 1;
        this.dashCooldown = 0;
        this.dashCooldownMax = 1;
        this.dashDuration = 0;
        this.specialWeapon = null;
        this.specialAmmo = 0;

        this.aimPoint = new THREE.Vector3(0, 0, 10);
        this.raycaster = new THREE.Raycaster();
        this.aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

        this.displayOffsetX = 0;
        this.localOffsetX = 0;
        this.scrollZ = 0;
    }

    _buildModel() {
        const skinMat = new THREE.MeshStandardMaterial({ color: 0xE8C28F });
        const shirtMat = new THREE.MeshStandardMaterial({ color: 0x4A6B3A });
        const pantsMat = new THREE.MeshStandardMaterial({ color: 0x6B5A38 });
        const hatMat = new THREE.MeshStandardMaterial({ color: 0xAA3322 });
        const gunMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.7 });

        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.3), shirtMat);
        torso.position.y = 1.05;
        this.group.add(torso);

        const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), skinMat);
        head.position.y = 1.65;
        this.group.add(head);

        const band = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.06, 4, 8), hatMat);
        band.position.y = 1.75;
        band.rotation.x = Math.PI / 2;
        this.group.add(band);

        this.gunMesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.1), gunMat);
        this.gunMesh.position.set(0.35, 1.1, 0);
        this.group.add(this.gunMesh);

        this.legL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.4, 0.18), pantsMat);
        this.legL.position.set(-0.12, 0.5, 0);
        this.group.add(this.legL);
        this.legR = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.4, 0.18), pantsMat);
        this.legR.position.set(0.12, 0.5, 0);
        this.group.add(this.legR);
    }

    mount() {
        this.projectiles.forEach(p => p.destroy && p.destroy());
        this.projectiles = [];
        this.effects.forEach(e => e.destroy && e.destroy());
        this.effects = [];
        this.group.visible = false;
        this.dead = false;
        this.alive = true;
        this.hp = 1;
        this.invincibleTimer = 0;
    }

    dismount(tankPos) {
        this.group.position.copy(tankPos);
        this.group.position.x += 1.5;
        this.group.visible = true;
        this.hp = 1;
        this.dead = false;
        this.alive = true;
        this.invincibleTimer = 0;
    }

    update(dt, input, scrollZ) {
        if (!this.alive || !this.group.visible) return;

        this.scrollZ = scrollZ;

        // 無敵タイマー
        if (this.invincibleTimer > 0) {
            this.invincibleTimer -= dt;
            this.group.visible = Math.floor(this.invincibleTimer / 0.05) % 2 === 0;
            if (this.invincibleTimer <= 0) {
                this.group.visible = true;
                this.invincibleTimer = 0;
            }
        }

        let mx = 0, mz = 0;
        if (input.moveLeft) mx -= 1;
        if (input.moveRight) mx += 1;
        if (input.moveForward) mz += 1;
        if (input.moveBackward) mz -= 1;

        const len = Math.hypot(mx, mz);
        if (len > 0) {
            mx /= len; mz /= len;
            this.group.position.x += mx * this.speed * dt;
            this.group.position.z += mz * this.speed * dt;
            this.walkPhase += dt * 10;
            this.legL.rotation.x = Math.sin(this.walkPhase) * 0.5;
            this.legR.rotation.x = -Math.sin(this.walkPhase) * 0.5;
        }

        // 画面内制限
        this.group.position.x = Math.max(-14, Math.min(14, this.group.position.x));
        this.group.position.z = Math.max(scrollZ - 12, Math.min(scrollZ + 15, this.group.position.z));
        this.group.position.y = 0;

        this.displayOffsetX += (this.group.position.x - this.displayOffsetX) * 0.18;
        this.localOffsetX = this.group.position.x;

        // マウス照準
        const mouseNDC = new THREE.Vector2(input.mouseX, input.mouseY);
        this.raycaster.setFromCamera(mouseNDC, this.camera);
        const groundHit = new THREE.Vector3();
        if (this.raycaster.ray.intersectPlane(this.aimPlane, groundHit)) {
            this.aimPoint.copy(groundHit);
        }

        // 向き回転
        const dx = this.aimPoint.x - this.group.position.x;
        const dz = this.aimPoint.z - this.group.position.z;
        if (dx * dx + dz * dz > 0.01) {
            this.group.rotation.y = Math.atan2(dx, dz);
        }

        // 射撃
        if (input.fireHeld) {
            this._fire();
        }

        this.projectiles.forEach(p => p.update(dt));
        this.projectiles.forEach(p => {
            if (!p.alive && !p.impactPending && p.destroy) p.destroy();
        });
        this.projectiles = this.projectiles.filter(p => p.alive || p.impactPending);
        this.effects.forEach(e => e.update(dt));
        this.effects.forEach(e => {
            if (!e.alive && e.destroy) e.destroy();
        });
        this.effects = this.effects.filter(e => e.alive);
    }

    _fire() {
        const now = performance.now() / 1000;
        if (now - this.lastFireTime < this.fireRate) return;
        this.lastFireTime = now;

        const muzzlePos = this.group.position.clone();
        muzzlePos.y = 1.1;
        muzzlePos.x += Math.sin(this.group.rotation.y) * 0.35;
        muzzlePos.z += Math.cos(this.group.rotation.y) * 0.35;

        const dir = new THREE.Vector3().subVectors(this.aimPoint, muzzlePos);
        if (dir.lengthSq() < 0.01) return;
        dir.normalize();
        dir.x += (Math.random() - 0.5) * 0.04;
        dir.y += (Math.random() - 0.5) * 0.02;
        dir.normalize();

        const bullet = new Projectile(this.scene, {
            position: muzzlePos,
            direction: dir,
            speed: 48,
            damage: 8,
            owner: 'player',
            type: 'bullet',
            maxDistance: 80,
        });
        this.projectiles.push(bullet);

        const flash = new Explosion(this.scene, muzzlePos, { type: 'muzzle', color: 0xFFAA00 });
        this.effects.push(flash);
    }

    takeDamage(amount) {
        if (this.dead || this.invincibleTimer > 0) return;
        this.hp = 0;
        this.dead = true;
        this.alive = false;
        this.invincibleTimer = 0;
        this.group.visible = false;
    }

    isInvincible() {
        return this.invincibleTimer > 0 || this.dead;
    }

    getPosition() {
        return this.group.position.clone();
    }

    getAimPoint() {
        return this.aimPoint.clone();
    }

    getAimAngleDeg() {
        return 0;
    }

    getAimMode() {
        return 'mouse';
    }

    // GameManager の HUD 更新用 (UIManager._updateHpBar など)
    get turretGroup() { return null; }
    get visualGroup() { return null; }
}
