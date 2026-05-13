import * as THREE from 'three';

// チャンクごとに大量に new されていたマテリアル（同色・同設定）を共有して
// GC とドローコール経由のシェーダ uniform 切り替えを抑える。
// userData.shared=true を持つマテリアル/ジオメトリは destroyObstacle・チャンク dispose で
// dispose しない。色がランダムなものは引き続き個別アロケーションする。
const _sharedMatCache = new Map();
function _sharedMat(key, factory) {
    let m = _sharedMatCache.get(key);
    if (!m) {
        m = factory();
        m.userData.shared = true;
        _sharedMatCache.set(key, m);
    }
    return m;
}

/**
 * Metal Slug風 縦スクロール 3D 用ワールド
 * プレイヤーは +Z 方向（前方）へ自動前進する
 * - 多層パララックス背景（左右の壁として配置）
 * - 石造りの建物群、監視塔、鉄骨構造物
 * - 道路、地面テクスチャ
 * - 環境小道具（土嚢、木箱、ドラム缶、有刺鉄線、テント、看板）
 */
export class World {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.options = options;
        this.backgroundPhotoUrl = this.options.backgroundPhotoUrl || null;
        this.chunks = [];
        this.chunkSize = 30;
        this.lastChunkZ = -this.chunkSize;
        // viewRange 90→60: 後半シーンで活きるチャンク数を抑え、毎フレームの描画
        // メッシュ数 / シャドウキャスタ数を削減（点滅・重さの主要因）。
        // フォグ（main.js）が遠景を 70 付近で十分フェードさせるためポップインは目立たない。
        this.viewRange = 60;
        this.cleanupRange = 28;
        // 1 フレームあたりの最大 dispose チャンク数。前方生成の速さに対し追従できる
        // よう 4 に引き上げ、後方プロップの滞留を防ぐ。
        this.maxChunkDisposesPerFrame = 4;

        this.bgLayers = [];
        this.props = [];
        this.clouds = [];
        this.photoForegroundMeshes = [];
        // ダイナミックプロップ（炎/煙/揺れ/回転光など毎フレーム更新）
        this.dynamicProps = [];

        // getObstacles() の結果をキャッシュ（毎フレーム新配列を作らないため）。
        // チャンク追加/削除・障害物破壊で dirty にして再構築する。
        this._obstacleCache = [];
        this._obstacleCacheDirty = true;

        this._buildSky();
        this._buildParallaxLayers();
        this._buildGround();
        this._buildFarHorizonSilhouettes();
        this._buildAtmosphere();

        // パララックス・雲を +Z 縦スクロール用に座標変換（+X/-X 両側の壁に再配置）
        this._transformLayersToForwardScroll();
        this._transformCloudsToForwardScroll();

        for (let z = -this.chunkSize; z <= this.chunkSize * 2; z += this.chunkSize) {
            this._generateChunk(z);
        }
    }

    /**
     * パララックス背景の座標変換（X 横スクロール → Z 縦スクロール）
     * 各オブジェクトの (x, y, z) を (lateral_side*depth, y, original_x) に再配置し、
     * 交互に左右へ割り振る。
     */
    _transformLayersToForwardScroll() {
        this.bgLayers.forEach(layer => {
            const depth = Math.abs(layer.zPos || 60);
            layer.objects.forEach((obj, i) => {
                const origX = obj.position.x;
                const origZ = obj.position.z;
                const zJitter = origZ - (layer.zPos || 0);
                const side = (i % 2 === 0) ? -1 : 1;
                obj.position.x = side * (depth + zJitter * 0.5);
                obj.position.z = origX;
                obj.rotation.y += side > 0 ? -Math.PI / 2 : Math.PI / 2;
            });
        });
    }

    _transformCloudsToForwardScroll() {
        this.clouds.forEach(c => {
            const origX = c.group.position.x;  // 元の X 拡散（-70 〜 +70）
            const origZ = c.group.position.z;  // 元の Z 深さ（-35 〜 -85）
            c.group.position.x = origZ;        // 雲は空なので左側（-X）に来る → 受け入れる
            c.group.position.z = origX;        // 前後方向へ散らす
            c.baseX = c.group.position.x;
        });
    }

    /* ========================================================
     *  SKY - Metal Slug風の温かな砂漠の空
     *  コンセプト画像 07_desert_background.jpg より
     * ======================================================== */
    _buildSky() {
        const skyGeo = new THREE.SphereGeometry(200, 48, 24);
        const skyMat = new THREE.ShaderMaterial({
            uniforms: {
                topColor:    { value: new THREE.Color(0x1A4FA8) },  // 深い空 (concept 07 上空)
                midColor:    { value: new THREE.Color(0x6FB6E8) },  // 鮮やかな水色
                bottomColor: { value: new THREE.Color(0xF5DEA0) },  // 砂塵色（地平線下）
                horizonColor:{ value: new THREE.Color(0xFFD668) },  // ゴールデンホライズン
                hazeColor:   { value: new THREE.Color(0xFFE8B8) },  // 地平線ヘイズ
                sunDir:      { value: new THREE.Vector3(0.45, 0.18, 0.88).normalize() },
                sunColor:    { value: new THREE.Color(0xFFF6CC) },
                offset:      { value: 10 },
                exponent:    { value: 0.5 },
            },
            vertexShader: `
                varying vec3 vWorldPosition;
                void main() {
                    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                    vWorldPosition = worldPosition.xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 topColor;
                uniform vec3 midColor;
                uniform vec3 bottomColor;
                uniform vec3 horizonColor;
                uniform vec3 hazeColor;
                uniform vec3 sunDir;
                uniform vec3 sunColor;
                uniform float offset;
                uniform float exponent;
                varying vec3 vWorldPosition;
                void main() {
                    vec3 dir = normalize(vWorldPosition + offset);
                    float h = dir.y;
                    vec3 color;
                    if (h > 0.35) {
                        color = mix(midColor, topColor, pow((h - 0.35) / 0.65, 0.85));
                    } else if (h > 0.06) {
                        color = mix(horizonColor, midColor, smoothstep(0.06, 0.35, h));
                    } else if (h > 0.0) {
                        color = mix(hazeColor, horizonColor, h / 0.06);
                    } else {
                        color = mix(bottomColor, hazeColor, clamp(h / -0.05 + 1.0, 0.0, 1.0));
                    }
                    // 太陽グロー（広く拡散）
                    float sunDot = max(dot(dir, sunDir), 0.0);
                    float glow = pow(sunDot, 6.0) * 0.55;
                    color += sunColor * glow;
                    // 太陽コア（明るい円）
                    float core = smoothstep(0.9985, 0.9998, sunDot);
                    color = mix(color, vec3(1.0, 0.98, 0.85), core);
                    // 地平線ヘイズの追加バンド
                    float horizonBand = exp(-pow(h * 6.0, 2.0)) * 0.25;
                    color = mix(color, hazeColor, horizonBand);
                    gl_FragColor = vec4(color, 1.0);
                }
            `,
            side: THREE.BackSide,
        });
        const sky = new THREE.Mesh(skyGeo, skyMat);
        this.scene.add(sky);
        this.skyMesh = sky;

        // 太陽光ハロー（さらに大きい外側のソフトディスク、空の上に重ねる）
        const sunHaloGeo = new THREE.PlaneGeometry(40, 40);
        const sunHaloMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: false,
            fog: false,
            blending: THREE.AdditiveBlending,
            uniforms: { tint: { value: new THREE.Color(0xFFE8A0) } },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 tint;
                varying vec2 vUv;
                void main() {
                    float d = distance(vUv, vec2(0.5));
                    float a = smoothstep(0.5, 0.0, d) * 0.5;
                    gl_FragColor = vec4(tint, a);
                }
            `,
        });
        const sunHalo = new THREE.Mesh(sunHaloGeo, sunHaloMat);
        // sunDir の方向に配置（半径 ~150）
        const sd = skyMat.uniforms.sunDir.value;
        sunHalo.position.set(sd.x * 150, sd.y * 150, sd.z * 150);
        sunHalo.lookAt(0, 0, 0);
        sunHalo.renderOrder = -1;
        this.scene.add(sunHalo);
        this.sunHalo = sunHalo;

        // Web由来の背景写真レイヤー（ライセンス許諾済み素材を想定）
        const photoUrl = this.options.backgroundPhotoUrl || null;
        if (photoUrl) {
            const photoSphere = new THREE.Mesh(
                new THREE.SphereGeometry(198, 48, 24),
                new THREE.MeshBasicMaterial({
                    color: 0xFFFFFF,
                    transparent: true,
                    opacity: 0.42,
                    side: THREE.BackSide,
                    depthWrite: false,
                    fog: false,
                })
            );
            photoSphere.visible = false;
            this.scene.add(photoSphere);
            this.skyPhotoMesh = photoSphere;

            const loader = new THREE.TextureLoader();
            loader.crossOrigin = 'anonymous';
            loader.load(
                photoUrl,
                (tex) => {
                    tex.colorSpace = THREE.SRGBColorSpace;
                    tex.wrapS = THREE.RepeatWrapping;
                    tex.wrapT = THREE.ClampToEdgeWrapping;
                    tex.anisotropy = 4;
                    this.skyPhotoMesh.material.map = tex;
                    this.skyPhotoMesh.material.needsUpdate = true;
                    this.skyPhotoMesh.visible = true;
                    this.photoForegroundMeshes.forEach(({ mesh }) => {
                        if (mesh.material.uniforms && mesh.material.uniforms.map) {
                            mesh.material.uniforms.map.value = tex;
                            if (mesh.material.uniforms.hasMap) {
                                mesh.material.uniforms.hasMap.value = 1.0;
                            }
                        } else {
                            mesh.material.map = tex;
                        }
                        mesh.material.needsUpdate = true;
                    });
                },
                undefined,
                () => {
                    this.skyPhotoMesh.visible = false;
                }
            );
        }

        // 写真背景モードでは雲を重ねず、同一画像で統一感を優先
        if (!this.backgroundPhotoUrl) {
            this._buildClouds();
        }
    }

    _buildClouds() {
        // コンセプト画像 C0mVPN3lN3L6: アフリカ村の青空に浮かぶ白い積雲
        const cloudColors = [0xFFFFFF, 0xFAF8F2, 0xF5F0E8, 0xEEE8DC];
        for (let i = 0; i < 28; i++) {
            const cloudGroup = new THREE.Group();
            const numPuffs = 5 + Math.floor(Math.random() * 6);
            const baseSize = 2.5 + Math.random() * 4.0;
            const colorIdx = Math.floor(Math.random() * cloudColors.length);

            for (let j = 0; j < numPuffs; j++) {
                const puffGeo = new THREE.SphereGeometry(
                    baseSize * (0.5 + Math.random() * 0.6), 8, 6
                );
                const puffMat = new THREE.MeshStandardMaterial({
                    color: cloudColors[colorIdx],
                    transparent: true,
                    opacity: 0.78 + Math.random() * 0.18,
                    roughness: 0.95,
                    emissive: 0xFFFFFF,
                    emissiveIntensity: 0.08,
                });
                const puff = new THREE.Mesh(puffGeo, puffMat);
                puff.position.set(
                    (Math.random() - 0.5) * baseSize * 3,
                    (Math.random() - 0.5) * baseSize * 0.6,
                    (Math.random() - 0.5) * baseSize * 1.5
                );
                puff.scale.y = 0.35 + Math.random() * 0.25;
                cloudGroup.add(puff);
            }
            // 雲の底面を暗くする影パフ
            const shadowPuff = new THREE.Mesh(
                new THREE.SphereGeometry(baseSize * 0.8, 6, 4),
                new THREE.MeshStandardMaterial({
                    color: 0x999999, transparent: true, opacity: 0.2, roughness: 1.0,
                })
            );
            shadowPuff.position.y = -baseSize * 0.3;
            shadowPuff.scale.y = 0.2;
            cloudGroup.add(shadowPuff);

            cloudGroup.position.set(
                (Math.random() - 0.5) * 140,
                18 + Math.random() * 25,
                -35 - Math.random() * 50
            );
            this.scene.add(cloudGroup);
            this.clouds.push({
                group: cloudGroup,
                speed: 0.2 + Math.random() * 0.4,
                baseX: cloudGroup.position.x,
            });
        }
    }

    /* ========================================================
     *  PARALLAX LAYERS - 6層の背景（砂漠テーマ強化）
     * ======================================================== */
    _buildParallaxLayers() {
        // 写真背景モード: 建築物パララックスを使わず、同一画像で前景までカバー
        if (this.backgroundPhotoUrl) {
            this._buildPhotoForegroundLayers();
            return;
        }

        // Layer 0: 最遠景 - ピラミッド群 (Z=-85, rate=0.02)
        this._buildDistantPyramids(-85, 0.02);
        // Layer 1: 最遠景 - 山脈/砂丘シルエット (Z=-70, rate=0.05)
        this._buildDistantMountains(-70, 0.05);
        // Layer 2: 遠景 - 大きな建物・工場・遺跡 (Z=-45, rate=0.15)
        this._buildDistantBuildings(-45, 0.15);
        // Layer 3: 中景 - 石造り建物群・監視塔・オベリスク (Z=-22, rate=0.35)
        this._buildMidgroundBuildings(-22, 0.35);
        // Layer 4: 近景 - 鉄骨構造物・電柱・ヤシの木 (Z=-10, rate=0.55)
        this._buildForegroundStructures(-10, 0.55);
        // Layer 5: 最前景 - 壊れた車両・瓦礫・岩 (Z=-4, rate=0.75)
        this._buildNearForeground(-4, 0.75);
    }

    /**
     * 写真パネル用 アルファフェード シェーダ素材
     * - UV V を [vMin, vMax] にクロップして空・地平線部分だけサンプル可能
     * - 下端 fadeBottom / 上端 fadeTop で滑らかにアルファをフェード
     * - hazeColor を horizonMix の強さで地平線寄りにブレンドし、ヘイズと馴染ませる
     */
    _makePhotoFadeMaterial({
        uMin = 0.0, uMax = 1.0,
        vMin = 0.0, vMax = 1.0,
        fadeBottom = 0.18, fadeTop = 0.0,
        opacity = 1.0,
        hazeColor = 0xE8C890,
        horizonMix = 0.22,
    } = {}) {
        return new THREE.ShaderMaterial({
            uniforms: {
                map:        { value: null },
                hasMap:     { value: 0.0 },
                uRange:     { value: new THREE.Vector2(uMin, uMax) },
                vRange:     { value: new THREE.Vector2(vMin, vMax) },
                opacityMul: { value: opacity },
                fadeBottom: { value: fadeBottom },
                fadeTop:    { value: fadeTop },
                haze:       { value: new THREE.Color(hazeColor) },
                horizonMix: { value: horizonMix },
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D map;
                uniform float hasMap;
                uniform vec2 uRange;
                uniform vec2 vRange;
                uniform float opacityMul;
                uniform float fadeBottom;
                uniform float fadeTop;
                uniform vec3 haze;
                uniform float horizonMix;
                varying vec2 vUv;
                void main() {
                    if (hasMap < 0.5) discard;
                    vec2 uv = vec2(
                        mix(uRange.x, uRange.y, vUv.x),
                        mix(vRange.x, vRange.y, vUv.y)
                    );
                    vec3 col = texture2D(map, uv).rgb;
                    // 下端ほどヘイズ色に寄せて地面となじませる
                    float hazeAmt = horizonMix * (1.0 - smoothstep(0.0, 0.55, vUv.y));
                    col = mix(col, haze, hazeAmt);
                    float a = opacityMul;
                    if (fadeBottom > 0.0) a *= smoothstep(0.0, fadeBottom, vUv.y);
                    if (fadeTop > 0.0)    a *= 1.0 - smoothstep(1.0 - fadeTop, 1.0, vUv.y);
                    gl_FragColor = vec4(col, a);
                }
            `,
            transparent: true,
            depthWrite: false,
            depthTest: true,
            side: THREE.DoubleSide,
        });
    }

    _buildPhotoForegroundLayers() {
        // 左右の壁: 写真フル UV、下端を地面にアルファブレンドして縫い目を消す
        // 高さは 36（y=0 〜 36）。地面の y=0 にぴったり乗せる
        for (const side of [-1, 1]) {
            const wall = new THREE.Mesh(
                new THREE.PlaneGeometry(260, 36),
                this._makePhotoFadeMaterial({
                    uMin: 0.0, uMax: 3.5,           // 横方向に 3.5 回タイル（260m カバー）
                    vMin: 0.0, vMax: 1.0,
                    fadeBottom: 0.22,
                    fadeTop: 0.0,
                    opacity: 1.0,
                    horizonMix: 0.30,
                })
            );
            wall.position.set(side * 44, 18, 0);
            wall.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
            this.scene.add(wall);
            this.photoForegroundMeshes.push({ mesh: wall, baseX: wall.position.x, zOffset: 0 });
        }

        // 前方パネル: 写真の上半分（空 + 遠方の地平線）だけを使い、
        // 下端を地面にフェードして「遠景の砂漠が地面と繋がっている」感を出す
        const front = new THREE.Mesh(
            new THREE.PlaneGeometry(180, 24),
            this._makePhotoFadeMaterial({
                uMin: 0.05, uMax: 0.95,
                vMin: 0.45, vMax: 0.98,           // 上半分の空〜地平線部分のみ
                fadeBottom: 0.32,
                fadeTop: 0.04,
                opacity: 1.0,
                horizonMix: 0.35,
            })
        );
        front.position.set(0, 12, 78);            // bottom = 0、地面に着地。z は遠めに
        front.rotation.y = Math.PI;
        this.scene.add(front);
        this.photoForegroundMeshes.push({ mesh: front, baseX: 0, isFront: true, zOffset: 78 });
    }

    /* ========================================================
     *  ATMOSPHERE — 砂漠の熱波 + 砂粒子（プレイヤー周辺の浮遊）
     * ======================================================== */
    _buildAtmosphere() {
        // 1) 熱波シマー（地面付近の半透明小ディスク群、上下にゆらぐ）
        this.heatShimmers = [];
        const shimmerMat = new THREE.MeshBasicMaterial({
            color: 0xFFEFBF,
            transparent: true,
            opacity: 0.10,
            depthWrite: false,
            fog: false,
            blending: THREE.AdditiveBlending,
        });
        const shimmerGeo = new THREE.PlaneGeometry(2.0, 0.8);
        for (let i = 0; i < 16; i++) {
            const m = new THREE.Mesh(shimmerGeo, shimmerMat);
            m.rotation.x = -Math.PI * 0.32;
            const lateral = (Math.random() - 0.5) * 70;
            if (Math.abs(lateral) < 5) continue;
            m.position.set(lateral, 0.4 + Math.random() * 0.3, (Math.random() - 0.5) * 80);
            this.scene.add(m);
            this.heatShimmers.push({
                mesh: m,
                phase: Math.random() * Math.PI * 2,
                speed: 0.8 + Math.random() * 0.5,
                amp: 0.15 + Math.random() * 0.15,
                baseY: m.position.y,
            });
        }

        // 2) 風で流れる砂粒子（プレイヤー周辺、低高度）
        this.sandDrift = [];
        const sandMat = new THREE.MeshBasicMaterial({
            color: 0xE8C078,
            transparent: true,
            opacity: 0.45,
            depthWrite: false,
            fog: false,
        });
        const sandGeo = new THREE.SphereGeometry(0.04, 4, 3);
        for (let i = 0; i < 28; i++) {
            const grain = new THREE.Mesh(sandGeo, sandMat);
            grain.position.set(
                (Math.random() - 0.5) * 60,
                0.2 + Math.random() * 2.0,
                (Math.random() - 0.5) * 70
            );
            this.scene.add(grain);
            this.sandDrift.push({
                mesh: grain,
                vx: 1.5 + Math.random() * 1.2,
                vy: -0.2 + Math.random() * 0.4,
                phase: Math.random() * Math.PI * 2,
                bobAmp: 0.05 + Math.random() * 0.1,
            });
        }
    }

    /* ========================================================
     *  FAR HORIZON SILHOUETTES — 写真モード/プロシージャルモード両対応
     *  前方遠景に砂丘 + 岩山 + 廃墟塔のシルエットを並べ、
     *  地平線に Metal Slug らしい奥行きを出す
     * ======================================================== */
    _buildFarHorizonSilhouettes() {
        this.farSilhouettes = [];
        const farZ = 95;     // プレイヤーから前方の距離
        const sideZ = 110;   // 横方向にも配置
        // 大気遠近法のため、ベース色をヘイズ (0xE8C890) と 50% ブレンドして
        // くっきりしたシルエットではなく霞んだ遠景として描画する
        const hazeColor = new THREE.Color(0xE8C890);
        const mixHaze = (hex, amount) => {
            const c = new THREE.Color(hex);
            c.lerp(hazeColor, amount);
            return c.getHex();
        };
        const palette = [
            { color: mixHaze(0xB58A52, 0.55), scale: 1.0 },
            { color: mixHaze(0xA47D49, 0.50), scale: 0.85 },
            { color: mixHaze(0xC8A06C, 0.45), scale: 1.1 },
            { color: mixHaze(0x8C6638, 0.55), scale: 0.7 },
        ];

        const makeDuneSilhouette = (width, height, colorHex) => {
            const shape = new THREE.Shape();
            shape.moveTo(-width / 2, 0);
            const steps = 14;
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const x = (t - 0.5) * width;
                const bumps = Math.sin(t * Math.PI * 3.0) * 0.18 + Math.sin(t * Math.PI * 7.0) * 0.08;
                const y = (Math.sin(t * Math.PI) + bumps) * height;
                shape.lineTo(x, Math.max(y, 0));
            }
            shape.lineTo(width / 2, 0);
            const geo = new THREE.ShapeGeometry(shape);
            const mat = new THREE.MeshBasicMaterial({
                color: colorHex,
                transparent: true,
                opacity: 0.72,
                fog: false,
                depthWrite: false,
            });
            return new THREE.Mesh(geo, mat);
        };

        const makeRockSilhouette = (width, height, colorHex) => {
            const shape = new THREE.Shape();
            shape.moveTo(-width / 2, 0);
            // 岩山のジャギーなプロファイル
            const peaks = 5 + Math.floor(Math.random() * 3);
            for (let s = 0; s <= peaks * 2; s++) {
                const t = s / (peaks * 2);
                const x = (t - 0.5) * width;
                const isRidge = s % 2 === 1;
                const y = isRidge ? height * (0.6 + Math.random() * 0.4) : height * (0.2 + Math.random() * 0.2);
                shape.lineTo(x, y);
            }
            shape.lineTo(width / 2, 0);
            const geo = new THREE.ShapeGeometry(shape);
            const mat = new THREE.MeshBasicMaterial({
                color: colorHex,
                transparent: true,
                opacity: 0.65,
                fog: false,
                depthWrite: false,
            });
            return new THREE.Mesh(geo, mat);
        };

        // 前方遠景: 4 セグメントの砂丘ライン (z = scrollZ + farZ)
        for (let i = 0; i < 6; i++) {
            const p = palette[i % palette.length];
            const w = 50 + Math.random() * 30;
            const h = 8 + Math.random() * 14;
            const dune = (i % 3 === 0) ? makeRockSilhouette(w, h * 1.3, p.color) : makeDuneSilhouette(w, h, p.color);
            dune.position.set((i - 2.5) * 32 + (Math.random() - 0.5) * 8, 0, farZ + Math.random() * 12);
            // -Z 側を向く（プレイヤー側）
            dune.rotation.y = Math.PI;
            this.scene.add(dune);
            this.farSilhouettes.push({ mesh: dune, baseZOffset: dune.position.z, lateral: dune.position.x, parallax: 0.04 });
        }

        // 後方遠景（プレイヤー後ろの -Z 側、振り向き感を出す）
        for (let i = 0; i < 4; i++) {
            const p = palette[(i + 1) % palette.length];
            const w = 45 + Math.random() * 25;
            const h = 6 + Math.random() * 10;
            const dune = makeDuneSilhouette(w, h, p.color);
            dune.position.set((i - 1.5) * 36 + (Math.random() - 0.5) * 10, 0, -farZ - Math.random() * 10);
            // +Z 側を向く
            dune.rotation.y = 0;
            this.scene.add(dune);
            this.farSilhouettes.push({ mesh: dune, baseZOffset: dune.position.z, lateral: dune.position.x, parallax: 0.03 });
        }

        // 横方向の遠景（左右、写真パネルの外側に薄く見える）
        for (const side of [-1, 1]) {
            for (let i = 0; i < 3; i++) {
                const p = palette[i % palette.length];
                const w = 55 + Math.random() * 25;
                const h = 10 + Math.random() * 12;
                const dune = makeDuneSilhouette(w, h, p.color);
                dune.position.set(side * sideZ, 0, (i - 1) * 40);
                dune.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
                this.scene.add(dune);
                this.farSilhouettes.push({ mesh: dune, baseZOffset: dune.position.z, lateral: dune.position.x, parallax: 0.06, lateralRow: true });
            }
        }
    }

    /* --- Layer 0: 最遠景のピラミッド群（Metal Slug砂漠ステージの象徴） --- */
    _buildDistantPyramids(zPos, parallaxRate) {
        const layer = { objects: [], parallaxRate, zPos };
        // 大きなピラミッドを散在させる
        for (let i = -3; i <= 6; i++) {
            const pGroup = new THREE.Group();
            const height = 18 + Math.random() * 14;
            const base = height * 1.35;

            // メインのピラミッド（4面の正方錐台）
            const pyrGeo = new THREE.ConeGeometry(base / 2, height, 4);
            const sandColor = new THREE.Color().setHSL(
                0.1 + Math.random() * 0.03,
                0.50 + Math.random() * 0.12,
                0.55 + Math.random() * 0.10
            );
            const pyrMat = new THREE.MeshStandardMaterial({
                color: sandColor,
                roughness: 0.92,
                metalness: 0.0,
                flatShading: true,
            });
            const pyramid = new THREE.Mesh(pyrGeo, pyrMat);
            pyramid.rotation.y = Math.PI / 4; // 角を手前に
            pyramid.position.y = height / 2;
            pGroup.add(pyramid);

            // ピラミッド下部の陰影（砂埃がかかったような暗部）
            const shadowGeo = new THREE.ConeGeometry(base / 2 + 0.1, height * 0.3, 4);
            const shadow = new THREE.Mesh(
                shadowGeo,
                new THREE.MeshStandardMaterial({
                    color: sandColor.clone().multiplyScalar(0.75),
                    roughness: 0.95, flatShading: true,
                })
            );
            shadow.rotation.y = Math.PI / 4;
            shadow.position.y = height * 0.15;
            pGroup.add(shadow);

            // 頂上の摩耗（一部欠けた様子）
            if (Math.random() > 0.5) {
                const capGeo = new THREE.BoxGeometry(base * 0.08, base * 0.06, base * 0.08);
                const cap = new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({
                    color: sandColor.clone().multiplyScalar(1.1),
                    roughness: 0.9,
                }));
                cap.position.y = height + 0.1;
                cap.rotation.y = Math.PI / 4;
                pGroup.add(cap);
            }

            pGroup.position.set(
                i * 35 + (Math.random() - 0.5) * 14,
                0,
                zPos + (Math.random() - 0.5) * 18
            );
            this.scene.add(pGroup);
            layer.objects.push(pGroup);
        }
        this.bgLayers.push(layer);
    }

    /* --- Layer 1: 最遠景の砂丘/岩山シルエット（砂漠仕様） --- */
    _buildDistantMountains(zPos, parallaxRate) {
        const layer = { objects: [], parallaxRate, zPos };
        for (let i = -4; i <= 8; i++) {
            const mtnGroup = new THREE.Group();
            const isDune = Math.random() > 0.4;
            const height = isDune ? (6 + Math.random() * 8) : (12 + Math.random() * 14);
            const width = 18 + Math.random() * 18;

            // メイン山体（砂丘は低く広く、岩山は高く鋭く）
            let mtnGeo;
            if (isDune) {
                // 砂丘: 丸みのあるシェイプを作成
                const duneShape = new THREE.Shape();
                duneShape.moveTo(-width / 2, 0);
                const steps = 10;
                for (let s = 0; s <= steps; s++) {
                    const t = s / steps;
                    const x = (t - 0.5) * width;
                    const y = Math.sin(t * Math.PI) * height * (0.9 + Math.random() * 0.1);
                    duneShape.lineTo(x, y);
                }
                duneShape.lineTo(width / 2, 0);
                duneShape.lineTo(-width / 2, 0);
                mtnGeo = new THREE.ExtrudeGeometry(duneShape, { depth: 1, bevelEnabled: false });
            } else {
                // 岩山: 不規則なコーン
                mtnGeo = new THREE.ConeGeometry(width / 2, height, 5 + Math.floor(Math.random() * 3));
            }

            // 砂漠色のカラーパレット（タン/黄土色/茶色）
            const palettes = [
                { h: 0.10, s: 0.42, l: 0.42 }, // タン
                { h: 0.08, s: 0.48, l: 0.45 }, // 黄土色
                { h: 0.06, s: 0.38, l: 0.38 }, // 赤茶
                { h: 0.09, s: 0.32, l: 0.33 }, // 暗い土
            ];
            const p = palettes[Math.floor(Math.random() * palettes.length)];
            const mtnMat = new THREE.MeshStandardMaterial({
                color: new THREE.Color().setHSL(p.h, p.s, p.l),
                roughness: 0.98, metalness: 0.0,
                flatShading: !isDune,
            });
            const mountain = new THREE.Mesh(mtnGeo, mtnMat);
            if (!isDune) {
                mountain.position.y = height / 2;
            }
            mtnGroup.add(mountain);

            // 岩山の影面（陰影を強調）
            if (!isDune && Math.random() > 0.4) {
                const stripeGeo = new THREE.ConeGeometry(width / 2 - 0.5, height * 0.7, 5);
                const stripe = new THREE.Mesh(
                    stripeGeo,
                    new THREE.MeshStandardMaterial({
                        color: new THREE.Color().setHSL(p.h, p.s * 0.9, p.l * 0.75),
                        roughness: 0.95, flatShading: true,
                    })
                );
                stripe.position.set(-0.4, height * 0.3, 0.3);
                mtnGroup.add(stripe);
            }

            mtnGroup.position.set(
                i * 22 + (Math.random() - 0.5) * 10,
                0,
                zPos + (Math.random() - 0.5) * 12
            );
            this.scene.add(mtnGroup);
            layer.objects.push(mtnGroup);
        }
        this.bgLayers.push(layer);
    }

    /* --- Layer 2: 遠景の大きな建物・工場 --- */
    _buildDistantBuildings(zPos, parallaxRate) {
        const layer = { objects: [], parallaxRate, zPos };
        for (let i = -3; i <= 7; i++) {
            const bGroup = new THREE.Group();
            const type = Math.floor(Math.random() * 5);

            if (type <= 1) {
                // 大きな工場/倉庫
                this._buildFactory(bGroup);
            } else if (type === 2) {
                // 給水塔
                this._buildWaterTower(bGroup);
            } else if (type === 3) {
                // 煙突付き工場
                this._buildChimneyFactory(bGroup);
            } else {
                // 大きな廃墟ビル
                this._buildRuinedHighrise(bGroup);
            }

            bGroup.position.set(
                i * 28 + (Math.random() - 0.5) * 12,
                0,
                zPos + (Math.random() - 0.5) * 8
            );
            // 遠景でもダイナミックに: 大スケール
            const distScale = 1.4 + Math.random() * 0.6;
            bGroup.scale.setScalar(distScale);
            this.scene.add(bGroup);
            layer.objects.push(bGroup);
        }
        this.bgLayers.push(layer);
    }

    _buildFactory(group) {
        const w = 12 + Math.random() * 7;
        const h = 6 + Math.random() * 5;
        const bodyGeo = new THREE.BoxGeometry(w, h, 7);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: 0x787868, roughness: 0.82, metalness: 0.12,
        });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = h / 2;
        group.add(body);

        // 屋根（三角）
        const roofShape = new THREE.Shape();
        roofShape.moveTo(-w / 2 - 0.3, 0);
        roofShape.lineTo(0, 4.0);
        roofShape.lineTo(w / 2 + 0.3, 0);
        const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 7.5, bevelEnabled: false });
        const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({
            color: 0x9A5020, roughness: 0.85,
        }));
        roof.position.set(0, h, -3.75);
        group.add(roof);

        // 窓
        const winMat = new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.3 });
        for (let wy = 1.5; wy < h - 0.5; wy += 2.5) {
            for (let wx = -w / 2 + 1.5; wx < w / 2 - 0.5; wx += 2.0) {
                if (Math.random() > 0.3) {
                    const win = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.2), winMat);
                    win.position.set(wx, wy, 2.6);
                    group.add(win);
                }
            }
        }
    }

    _buildWaterTower(group) {
        const legMat = new THREE.MeshStandardMaterial({
            color: 0x5A5A5A, roughness: 0.6, metalness: 0.4,
        });
        for (let lx = -1.2; lx <= 1.2; lx += 2.4) {
            for (let lz = -0.6; lz <= 0.6; lz += 1.2) {
                const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 8, 6), legMat);
                leg.position.set(lx, 4, lz);
                group.add(leg);
            }
        }
        // 横梁
        for (let h = 2; h <= 6; h += 4) {
            for (let z of [-0.6, 0.6]) {
                const brace = new THREE.Mesh(
                    new THREE.BoxGeometry(2.8, 0.08, 0.08),
                    legMat
                );
                brace.position.set(0, h, z);
                group.add(brace);
            }
        }
        const tankGeo = new THREE.CylinderGeometry(1.8, 1.8, 2.5, 12);
        const tank = new THREE.Mesh(tankGeo, new THREE.MeshStandardMaterial({
            color: 0x7B8B7B, roughness: 0.5, metalness: 0.3,
        }));
        tank.position.y = 9.5;
        group.add(tank);
        // タンク上部の蓋
        const lid = new THREE.Mesh(
            new THREE.ConeGeometry(2.0, 1.0, 12),
            new THREE.MeshStandardMaterial({ color: 0x6B7B6B, roughness: 0.6 })
        );
        lid.position.y = 11.2;
        group.add(lid);
    }

    _buildChimneyFactory(group) {
        // 本体
        const bodyGeo = new THREE.BoxGeometry(10, 7, 6);
        const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({
            color: 0x7B6B5B, roughness: 0.85,
        }));
        body.position.y = 3.5;
        group.add(body);

        // 煙突（2本）
        for (let x of [-1.5, 1.5]) {
            const chimney = new THREE.Mesh(
                new THREE.CylinderGeometry(0.55, 0.65, 12, 8),
                new THREE.MeshStandardMaterial({ color: 0x8B5A2B, roughness: 0.7, metalness: 0.2 })
            );
            chimney.position.set(x, 13, 0);
            group.add(chimney);

            // 煙突の上部リング
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(0.5, 0.08, 6, 12),
                new THREE.MeshStandardMaterial({ color: 0x5A4A3A, metalness: 0.3 })
            );
            ring.position.set(x, 13, 0);
            ring.rotation.x = Math.PI / 2;
            group.add(ring);
        }

        // パイプ
        const pipe = new THREE.Mesh(
            new THREE.CylinderGeometry(0.2, 0.2, 4, 6),
            new THREE.MeshStandardMaterial({ color: 0x6A6A5A, metalness: 0.4 })
        );
        pipe.position.set(3.2, 3, 0);
        pipe.rotation.z = 0.3;
        group.add(pipe);
    }

    _buildRuinedHighrise(group) {
        const h = 12 + Math.random() * 12;
        const w = 6 + Math.random() * 4;
        const bodyGeo = new THREE.BoxGeometry(w, h, 5);
        const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({
            color: 0x8B7B6B, roughness: 0.9,
        }));
        body.position.y = h / 2;
        group.add(body);

        // 窓の穴（暗い四角）
        const winMat = new THREE.MeshStandardMaterial({ color: 0x2A2A2A, roughness: 0.5 });
        for (let wy = 1.5; wy < h - 1; wy += 2.0) {
            for (let wx = -w / 3; wx <= w / 3; wx += w / 3) {
                if (Math.random() > 0.25) {
                    const win = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.3), winMat);
                    win.position.set(wx, wy, 1.8);
                    group.add(win);
                }
            }
        }

        // 崩れた上部（不規則な形）
        if (Math.random() > 0.4) {
            const debrisGeo = new THREE.BoxGeometry(w * 0.6, 1.5, 2);
            const debris = new THREE.Mesh(debrisGeo, new THREE.MeshStandardMaterial({
                color: 0x7B6B5B, roughness: 0.95,
            }));
            debris.position.set((Math.random() - 0.5) * w * 0.3, h + 0.5, 0);
            debris.rotation.z = (Math.random() - 0.5) * 0.3;
            group.add(debris);
        }
    }

    /* --- Layer 3: 中景の石造り建物群・監視塔・砂漠遺跡・アフリカ村 --- */
    _buildMidgroundBuildings(zPos, parallaxRate) {
        const layer = { objects: [], parallaxRate, zPos };
        // アフリカ村の小屋密度を上げる
        for (let i = -4; i <= 8; i++) {
            const bGroup = new THREE.Group();
            // 0-15: 重み付き選択。コンセプト画像（C0mVPN3lN3L6）に合わせ
            // 茅葺き集落を最多に、アラビア/監視塔は脇役へ
            const r = Math.random();
            if (r < 0.28) {
                // アフリカ村集落（複数小屋）
                this._buildVillageCluster(bGroup);
            } else if (r < 0.36) {
                // 単独の大きな小屋
                this._buildThatchedHut(bGroup, {
                    radius: 1.8 + Math.random() * 0.6,
                    wallH: 1.6 + Math.random() * 0.4,
                    roofH: 3.0 + Math.random() * 0.6,
                });
            } else if (r < 0.50) {
                // フラット屋根アドベ（ヴィガ突き出し梁）— ジオラマ風
                this._buildFlatAdobeHouse(bGroup);
            } else if (r < 0.57) {
                // 装飾された石壁
                this._buildDecoratedStoneWall(bGroup);
            } else if (r < 0.64) {
                this._buildWatchTower(bGroup);
            } else if (r < 0.70) {
                this._buildStoneBuilding(bGroup);
            } else if (r < 0.76) {
                this._buildAdobeHouse(bGroup);
            } else if (r < 0.82) {
                this._buildDesertRuins(bGroup);
            } else if (r < 0.86) {
                this._buildWarehouse(bGroup);
            } else if (r < 0.90) {
                this._buildFortWall(bGroup);
            } else if (r < 0.94) {
                this._buildArabianTemple(bGroup);
            } else if (r < 0.97) {
                this._buildBazaarStall(bGroup);
            } else {
                this._buildArabianGate(bGroup);
            }

            bGroup.position.set(
                i * 20 + (Math.random() - 0.5) * 9,
                0,
                zPos + (Math.random() - 0.5) * 5
            );
            // ダイナミックなアーケード感: ランダムにスケールアップ
            const buildingScale = 1.3 + Math.random() * 0.5;
            bGroup.scale.setScalar(buildingScale);
            this.scene.add(bGroup);
            layer.objects.push(bGroup);
        }
        this.bgLayers.push(layer);
    }

    /* ========================================================
     *  アラビア建築ヘルパー
     * ======================================================== */
    /** オニオンドーム（玉ねぎ形ドーム）— Lathe で球根状のプロファイルを作る */
    _buildOnionDome(baseR, totalH, color, segments = 18) {
        const points = [];
        points.push(new THREE.Vector2(baseR * 0.58, 0));
        points.push(new THREE.Vector2(baseR * 0.88, totalH * 0.06));
        points.push(new THREE.Vector2(baseR * 1.12, totalH * 0.22));
        points.push(new THREE.Vector2(baseR * 1.22, totalH * 0.38));
        points.push(new THREE.Vector2(baseR * 1.08, totalH * 0.52));
        points.push(new THREE.Vector2(baseR * 0.78, totalH * 0.66));
        points.push(new THREE.Vector2(baseR * 0.45, totalH * 0.80));
        points.push(new THREE.Vector2(baseR * 0.18, totalH * 0.92));
        points.push(new THREE.Vector2(0, totalH));
        const geo = new THREE.LatheGeometry(points, segments);
        const mat = new THREE.MeshStandardMaterial({
            color, roughness: 0.68, metalness: 0.12,
        });
        return new THREE.Mesh(geo, mat);
    }

    /** ドーム金スパイア（先端装飾）— 細い棒＋玉＋三日月 */
    _buildDomeFinial(y, x = 0, z = 0) {
        const group = new THREE.Group();
        const goldMat = new THREE.MeshStandardMaterial({
            color: 0xCA9B3C, metalness: 0.75, roughness: 0.3,
            emissive: 0x4a3010, emissiveIntensity: 0.15,
        });
        const rod = new THREE.Mesh(
            new THREE.CylinderGeometry(0.04, 0.05, 0.9, 6), goldMat
        );
        rod.position.set(x, y + 0.45, z);
        group.add(rod);
        const ball = new THREE.Mesh(
            new THREE.SphereGeometry(0.12, 8, 6), goldMat
        );
        ball.position.set(x, y + 1.0, z);
        group.add(ball);
        const cres = new THREE.Mesh(
            new THREE.TorusGeometry(0.14, 0.035, 6, 12, Math.PI * 1.1),
            goldMat
        );
        cres.position.set(x, y + 1.28, z);
        cres.rotation.x = Math.PI / 2;
        cres.rotation.z = -Math.PI / 2;
        group.add(cres);
        return group;
    }

    /** 尖頭アーチ開口部（暗いボックス＋上部の尖った台形）— 砂漠建築のドア/窓 */
    _buildPointedArch(w, h, depth = 0.12, color = 0x1E1008) {
        const group = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4 });
        // 下部矩形
        const rect = new THREE.Mesh(
            new THREE.BoxGeometry(w, h * 0.72, depth), mat
        );
        rect.position.y = h * 0.36;
        group.add(rect);
        // 上部の尖り（三角錐をスケール）
        const tip = new THREE.Mesh(
            new THREE.ConeGeometry(w / 2, h * 0.38, 4, 1), mat
        );
        tip.position.y = h * 0.72 + h * 0.19;
        tip.rotation.y = Math.PI / 4;
        tip.scale.z = depth / (w / Math.SQRT2);
        group.add(tip);
        return group;
    }

    /** 書法風バナー（青地＋クリーム縁＋書法を模した不規則ストローク） */
    _buildCalligraphyBanner(w, h, y, z) {
        const group = new THREE.Group();
        // 背景
        const bg = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, 0.08),
            new THREE.MeshStandardMaterial({ color: 0x3A5F8A, roughness: 0.85 })
        );
        bg.position.set(0, y, z);
        group.add(bg);
        // 上下クリーム縁
        for (const yOff of [h / 2 - 0.05, -h / 2 + 0.05]) {
            const border = new THREE.Mesh(
                new THREE.BoxGeometry(w, 0.07, 0.1),
                new THREE.MeshStandardMaterial({ color: 0xEEDCAA, roughness: 0.7 })
            );
            border.position.set(0, y + yOff, z + 0.02);
            group.add(border);
        }
        // 書法ストローク（クリーム色で不規則な縦横線）
        const ink = new THREE.MeshBasicMaterial({ color: 0xF0DDB0 });
        const glyphCount = Math.floor(w * 2.2);
        for (let g = 0; g < glyphCount; g++) {
            const gx = -w / 2 + 0.25 + (g / glyphCount) * (w - 0.5);
            // 縦ストローク
            const vs = new THREE.Mesh(
                new THREE.BoxGeometry(0.05, h * 0.5 * (0.6 + Math.random() * 0.4), 0.03),
                ink
            );
            vs.position.set(gx, y + (Math.random() - 0.5) * 0.08, z + 0.06);
            vs.rotation.z = (Math.random() - 0.5) * 0.2;
            group.add(vs);
            // 横/曲線ストローク（確率で）
            if (Math.random() > 0.5) {
                const hs = new THREE.Mesh(
                    new THREE.BoxGeometry(0.18, 0.05, 0.03),
                    ink
                );
                hs.position.set(gx + 0.04, y + (Math.random() - 0.5) * 0.25, z + 0.06);
                hs.rotation.z = (Math.random() - 0.5) * 0.5;
                group.add(hs);
            }
            // ドット（点）
            if (Math.random() > 0.7) {
                const dot = new THREE.Mesh(
                    new THREE.BoxGeometry(0.07, 0.07, 0.03), ink
                );
                dot.position.set(gx, y + h / 2 - 0.15, z + 0.06);
                group.add(dot);
            }
        }
        return group;
    }

    /** 縞模様のオーニング（テント屋根）— stripes×2色で層状に */
    _buildStripedAwning(width, depth, colorA, colorB, stripes = 8) {
        const group = new THREE.Group();
        const stripeW = depth / stripes;
        for (let i = 0; i < stripes; i++) {
            const stripe = new THREE.Mesh(
                new THREE.BoxGeometry(width, 0.04, stripeW + 0.01),
                new THREE.MeshStandardMaterial({
                    color: i % 2 === 0 ? colorA : colorB,
                    roughness: 0.82, side: THREE.DoubleSide,
                })
            );
            stripe.position.set(0, -i * 0.015, -depth / 2 + stripeW / 2 + i * stripeW);
            group.add(stripe);
        }
        // スカロップ（波状）の前縁
        const scallopColor = new THREE.MeshStandardMaterial({ color: colorA, roughness: 0.85 });
        const scallopCount = Math.floor(width / 0.35);
        for (let s = 0; s < scallopCount; s++) {
            const sc = new THREE.Mesh(
                new THREE.ConeGeometry(0.18, 0.3, 3, 1),
                scallopColor
            );
            sc.position.set(-width / 2 + 0.18 + s * (width / scallopCount), -0.15, depth / 2);
            sc.rotation.x = Math.PI;
            sc.scale.set(1, 1, 0.35);
            group.add(sc);
        }
        return group;
    }

    /* --- アラビア風寺院（概念画像の二連オニオンドーム） --- */
    _buildArabianTemple(group) {
        const wallColor = 0xDEBA7F;
        const wallColorDk = 0xB89366;
        const domeColor = 0x8C3B1C;    // テラコッタ（玉ねぎドーム）
        const domeShadow = 0x5E2613;
        const trimColor = 0x7A4A2A;
        const wallMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.92 });
        const wallMatDk = new THREE.MeshStandardMaterial({ color: wallColorDk, roughness: 0.92 });
        const trimMat = new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.85 });

        const w = 6.0, h = 4.8, d = 3.8;

        // 基壇（台石）
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.8, 0.4, d + 0.5), trimMat
        );
        base.position.y = 0.2;
        group.add(base);

        // 本体
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
        body.position.y = 0.4 + h / 2;
        group.add(body);

        // コーニス（装飾的な上縁、二段）
        const cornice1 = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.4, 0.25, d + 0.3), trimMat
        );
        cornice1.position.y = 0.4 + h - 0.15;
        group.add(cornice1);
        const cornice2 = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.6, 0.2, d + 0.4), wallMatDk
        );
        cornice2.position.y = 0.4 + h + 0.1;
        group.add(cornice2);

        // 胸壁の矩形装飾（階段状）
        for (let cx = -w / 2 + 0.3; cx < w / 2; cx += 0.6) {
            const merlon = new THREE.Mesh(
                new THREE.BoxGeometry(0.3, 0.3, 0.3), trimMat
            );
            merlon.position.set(cx, 0.4 + h + 0.35, d / 2 + 0.1);
            group.add(merlon);
        }

        // 中央の尖頭アーチ入り口
        const entrance = this._buildPointedArch(1.6, 2.8, 0.15, 0x2B1A0F);
        entrance.position.set(0, 0.4, d / 2 + 0.01);
        group.add(entrance);

        // 入り口の石枠（トリム）
        const doorFrame = new THREE.Mesh(
            new THREE.BoxGeometry(1.85, 0.15, 0.15), trimMat
        );
        doorFrame.position.set(0, 0.4 + 2.85, d / 2 + 0.08);
        group.add(doorFrame);
        for (const sx of [-0.9, 0.9]) {
            const side = new THREE.Mesh(
                new THREE.BoxGeometry(0.15, 2.4, 0.15), trimMat
            );
            side.position.set(sx, 0.4 + 1.25, d / 2 + 0.08);
            group.add(side);
        }

        // 書法バナー（入り口上）
        const banner = this._buildCalligraphyBanner(4.6, 0.7, 0.4 + h - 0.9, d / 2 + 0.1);
        group.add(banner);

        // 小さな尖頭アーチ窓（左右）
        for (const sx of [-2.0, 2.0]) {
            const win = this._buildPointedArch(0.55, 1.1, 0.1, 0x1A1020);
            win.position.set(sx, 0.4 + 0.9, d / 2 + 0.01);
            group.add(win);
            // 窓枠
            const frame = new THREE.Mesh(
                new THREE.BoxGeometry(0.7, 0.05, 0.1), trimMat
            );
            frame.position.set(sx, 0.4 + 2.0, d / 2 + 0.05);
            group.add(frame);
        }

        // 装飾タイル帯（本体中ほどに細い青帯）
        const tileBand = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.05, 0.12, d + 0.05),
            new THREE.MeshStandardMaterial({ color: 0x2E4D78, roughness: 0.5 })
        );
        tileBand.position.y = 0.4 + h * 0.35;
        group.add(tileBand);

        // 二連のオニオンドーム（本命）
        for (const dx of [-1.55, 1.55]) {
            // ドラム（ドーム下の円筒）
            const drum = new THREE.Mesh(
                new THREE.CylinderGeometry(0.95, 1.0, 0.8, 14), trimMat
            );
            drum.position.set(dx, 0.4 + h + 0.6, 0);
            group.add(drum);
            // ドラムの窓スリット（アーチ窓風）
            for (let ang = 0; ang < Math.PI * 2; ang += Math.PI / 4) {
                const slit = new THREE.Mesh(
                    new THREE.BoxGeometry(0.18, 0.45, 0.06),
                    new THREE.MeshStandardMaterial({ color: 0x1E1208 })
                );
                slit.position.set(
                    dx + Math.cos(ang) * 1.01,
                    0.4 + h + 0.6,
                    Math.sin(ang) * 1.01
                );
                slit.rotation.y = -ang + Math.PI / 2;
                group.add(slit);
            }

            // 本体のオニオンドーム
            const dome = this._buildOnionDome(1.1, 3.2, domeColor);
            dome.position.set(dx, 0.4 + h + 1.0, 0);
            group.add(dome);

            // 縦のリブ（ドーム面の縫い目）
            for (let r = 0; r < 10; r++) {
                const ang = (r / 10) * Math.PI * 2;
                const rib = new THREE.Mesh(
                    new THREE.BoxGeometry(0.04, 2.8, 0.04),
                    new THREE.MeshStandardMaterial({ color: domeShadow, roughness: 0.8 })
                );
                rib.position.set(
                    dx + Math.cos(ang) * 0.95,
                    0.4 + h + 2.2,
                    Math.sin(ang) * 0.95
                );
                rib.rotation.z = 0.08 * Math.cos(ang);
                rib.rotation.x = 0.08 * Math.sin(ang);
                group.add(rib);
            }

            // 先端装飾
            group.add(this._buildDomeFinial(0.4 + h + 4.2, dx, 0));
        }

        // 正面の縞オーニング（入り口ひさし）
        const awning = this._buildStripedAwning(2.4, 1.4, 0xD64A22, 0xEED67A, 6);
        awning.position.set(0, 0.4 + 3.1, d / 2 + 0.35);
        awning.rotation.x = -0.4;
        group.add(awning);

        // 入り口両脇のランタン
        for (const lx of [-1.0, 1.0]) {
            const hook = new THREE.Mesh(
                new THREE.CylinderGeometry(0.02, 0.02, 0.25, 4),
                new THREE.MeshStandardMaterial({ color: 0x3A2A1A })
            );
            hook.position.set(lx, 0.4 + 2.7, d / 2 + 0.2);
            group.add(hook);
            const lantern = new THREE.Mesh(
                new THREE.CylinderGeometry(0.12, 0.14, 0.32, 8),
                new THREE.MeshStandardMaterial({
                    color: 0xFFCC66, emissive: 0xE88822,
                    emissiveIntensity: 0.55, roughness: 0.5,
                })
            );
            lantern.position.set(lx, 0.4 + 2.4, d / 2 + 0.2);
            group.add(lantern);
        }
    }

    /* --- アドベ（土+岩）民家：縞ひさし・果物籠付き --- */
    _buildAdobeHouse(group) {
        const adobe = new THREE.MeshStandardMaterial({
            color: 0xC28E5A, roughness: 0.95, flatShading: true,
        });
        const adobeDk = new THREE.MeshStandardMaterial({
            color: 0x8E5C34, roughness: 0.96, flatShading: true,
        });
        const adobeLt = new THREE.MeshStandardMaterial({
            color: 0xD8A878, roughness: 0.94, flatShading: true,
        });

        const w = 5.2, h = 3.6, d = 3.4;

        // 1階本体
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), adobe);
        body.position.y = h / 2;
        group.add(body);

        // ランダムな岩ブロック（質感出し）
        for (let i = 0; i < 14; i++) {
            const sz = 0.35 + Math.random() * 0.35;
            const rock = new THREE.Mesh(
                new THREE.BoxGeometry(sz, sz * 0.7, sz * 0.55),
                [adobeLt, adobeDk, adobe][Math.floor(Math.random() * 3)]
            );
            rock.position.set(
                -w / 2 + Math.random() * w,
                0.2 + Math.random() * (h - 0.3),
                d / 2 + 0.0
            );
            rock.rotation.y = (Math.random() - 0.5) * 0.4;
            rock.rotation.z = (Math.random() - 0.5) * 0.2;
            group.add(rock);
        }

        // 2階（セットバック）
        const upperW = w * 0.62;
        const upperH = 2.2;
        const upper = new THREE.Mesh(
            new THREE.BoxGeometry(upperW, upperH, d), adobeDk
        );
        upper.position.set(w * 0.12, h + upperH / 2, 0);
        group.add(upper);
        // 2階の岩質感
        for (let i = 0; i < 7; i++) {
            const sz = 0.3 + Math.random() * 0.25;
            const rock = new THREE.Mesh(
                new THREE.BoxGeometry(sz, sz * 0.6, sz * 0.5),
                Math.random() > 0.5 ? adobeLt : adobe
            );
            rock.position.set(
                w * 0.12 - upperW / 2 + Math.random() * upperW,
                h + 0.15 + Math.random() * (upperH - 0.3),
                d / 2 + 0.0
            );
            group.add(rock);
        }

        // 1階の尖頭アーチ扉
        const door = this._buildPointedArch(1.1, 2.2, 0.12, 0x1E1008);
        door.position.set(-w * 0.22, 0, d / 2 + 0.01);
        group.add(door);

        // 扉上の縞オーニング（オレンジ×クリーム）
        const awning = this._buildStripedAwning(1.9, 1.0, 0xD94E22, 0xE8C16A, 6);
        awning.position.set(-w * 0.22, 2.55, d / 2 + 0.3);
        awning.rotation.x = -0.38;
        group.add(awning);

        // 小さな尖頭アーチ窓（1階・2階）
        const blueShutter = new THREE.MeshStandardMaterial({ color: 0x2F4E72, roughness: 0.8 });
        for (const sx of [w * 0.28, -w * 0.42]) {
            const win = this._buildPointedArch(0.5, 0.9, 0.08, 0x1A1020);
            win.position.set(sx, 1.95, d / 2 + 0.02);
            group.add(win);
            // 青い鎧戸
            for (const side of [-1, 1]) {
                const sh = new THREE.Mesh(
                    new THREE.BoxGeometry(0.28, 0.95, 0.04), blueShutter
                );
                sh.position.set(sx + side * 0.38, 2.25, d / 2 + 0.09);
                sh.rotation.y = side * 0.15;
                group.add(sh);
            }
        }
        // 2階の小さな窓
        const upperWin = this._buildPointedArch(0.45, 0.7, 0.08, 0x1A1020);
        upperWin.position.set(w * 0.12, h + 0.8, d / 2 + 0.02);
        group.add(upperWin);

        // 2階の小バルコニー
        const balcony = new THREE.Mesh(
            new THREE.BoxGeometry(upperW * 0.7, 0.15, 0.5), adobeLt
        );
        balcony.position.set(w * 0.12, h + 0.3, d / 2 + 0.25);
        group.add(balcony);
        // バルコニー手すり
        for (let bx = -upperW * 0.3; bx <= upperW * 0.3; bx += 0.2) {
            const bal = new THREE.Mesh(
                new THREE.BoxGeometry(0.05, 0.5, 0.05),
                new THREE.MeshStandardMaterial({ color: 0x5A3A1A })
            );
            bal.position.set(w * 0.12 + bx, h + 0.6, d / 2 + 0.45);
            group.add(bal);
        }

        // フラット屋根＋パラペット
        const roof = new THREE.Mesh(
            new THREE.BoxGeometry(upperW + 0.2, 0.15, d + 0.2), adobeDk
        );
        roof.position.set(w * 0.12, h + upperH + 0.1, 0);
        group.add(roof);
        for (let rx = -upperW / 2; rx < upperW / 2; rx += 0.4) {
            if (Math.random() > 0.25) {
                const pblock = new THREE.Mesh(
                    new THREE.BoxGeometry(0.3, 0.25, 0.3), adobeLt
                );
                pblock.position.set(w * 0.12 + rx, h + upperH + 0.3, d / 2);
                group.add(pblock);
            }
        }

        // 屋根上の物干し/鉢（確率）
        if (Math.random() > 0.5) {
            const pot = new THREE.Mesh(
                new THREE.CylinderGeometry(0.15, 0.2, 0.25, 8),
                new THREE.MeshStandardMaterial({ color: 0x8B4A22, roughness: 0.9 })
            );
            pot.position.set(w * 0.3, h + upperH + 0.35, -0.2);
            group.add(pot);
            const plant = new THREE.Mesh(
                new THREE.SphereGeometry(0.2, 6, 4),
                new THREE.MeshStandardMaterial({ color: 0x3B6A2A, roughness: 0.9 })
            );
            plant.position.set(w * 0.3, h + upperH + 0.6, -0.2);
            plant.scale.y = 0.7;
            group.add(plant);
        }

        // 前面の果物籠（オレンジ山積み）
        for (let k = 0; k < 2; k++) {
            const cx = -w * 0.55 + k * 0.85;
            const crate = new THREE.Mesh(
                new THREE.BoxGeometry(0.55, 0.45, 0.55),
                new THREE.MeshStandardMaterial({ color: 0x7B5A2A, roughness: 0.9 })
            );
            crate.position.set(cx, 0.225, d / 2 + 0.5);
            group.add(crate);
            // オレンジ山
            for (let o = 0; o < 6; o++) {
                const orange = new THREE.Mesh(
                    new THREE.SphereGeometry(0.11, 6, 5),
                    new THREE.MeshStandardMaterial({
                        color: 0xE87838, roughness: 0.75, emissive: 0x3a1a08,
                    })
                );
                orange.position.set(
                    cx + (Math.random() - 0.5) * 0.35,
                    0.52 + Math.floor(o / 3) * 0.18,
                    d / 2 + 0.5 + (Math.random() - 0.5) * 0.35
                );
                group.add(orange);
            }
        }

        // 入り口脇の壺
        const jar = new THREE.Mesh(
            new THREE.CylinderGeometry(0.22, 0.15, 0.7, 8),
            new THREE.MeshStandardMaterial({ color: 0x7A4E22, roughness: 0.9 })
        );
        jar.position.set(w * 0.1, 0.35, d / 2 + 0.35);
        group.add(jar);
        const jarNeck = new THREE.Mesh(
            new THREE.CylinderGeometry(0.1, 0.15, 0.2, 8),
            new THREE.MeshStandardMaterial({ color: 0x5A3A18, roughness: 0.9 })
        );
        jarNeck.position.set(w * 0.1, 0.8, d / 2 + 0.35);
        group.add(jarNeck);

        // === 中東風 装飾デコレーション（小ぶり版） ===
        // 物干しロープ（バルコニー脇）
        if (Math.random() > 0.4) {
            this._addClothesline(
                group,
                -w / 2 + 0.5, w / 2 - 0.5,
                h - 0.5,
                d / 2 + 0.16,
                { count: 4, sag: 0.14 }
            );
        }
        // 壁を這う蔓植物
        if (Math.random() > 0.55) {
            this._addHangingVines(
                group, -w * 0.35, h * 0.85, d / 2 + 0.05,
                1.2 + Math.random() * 0.6,
                { stemCount: 2, flowerColor: 0xE85A8A }
            );
        }
        // 屋根上の煙突
        if (Math.random() > 0.65) {
            this._addRoofChimney(
                group,
                w * 0.32 + (Math.random() - 0.5) * 0.4,
                h + 2.2 + 0.3,
                (Math.random() - 0.5) * d * 0.4
            );
        }
        // 屋根上の鉢植え追加
        if (Math.random() > 0.45) {
            this._addPotPlantCluster(
                group,
                -w * 0.25 + (Math.random() - 0.5) * 0.5,
                h + 2.2 + 0.3,
                d / 2 - 0.3,
                2
            );
        }
        // ペナント紐
        if (Math.random() > 0.5) {
            this._addPennantString(
                group,
                -w / 2, h + 0.4, d / 2 - 0.1,
                w / 2 - 0.3, h + 2.2 + 0.6, d / 2 + 0.2,
                6
            );
        }
        // 壁掛けタペストリー（バルコニー脇など）
        if (Math.random() > 0.6) {
            this._addWallTapestry(
                group,
                w * 0.3, 1.5, d / 2 + 0.11,
                0.7, 1.1
            );
        }
    }

    /* --- バザール（縞テント屋台） --- */
    _buildBazaarStall(group) {
        const wallMat = new THREE.MeshStandardMaterial({
            color: 0xCFA870, roughness: 0.93,
        });
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x7A4A22, roughness: 0.9 });

        // 後ろの壁（アドベ）
        const wall = new THREE.Mesh(
            new THREE.BoxGeometry(5.2, 3.6, 1.6), wallMat
        );
        wall.position.set(0, 1.8, -0.8);
        group.add(wall);
        // 壁の粗い岩質感
        for (let i = 0; i < 8; i++) {
            const sz = 0.3 + Math.random() * 0.3;
            const rock = new THREE.Mesh(
                new THREE.BoxGeometry(sz, sz * 0.65, sz * 0.45),
                new THREE.MeshStandardMaterial({
                    color: [0xB88A58, 0xD8A878, 0x8C5A30][Math.floor(Math.random() * 3)],
                    roughness: 0.95, flatShading: true,
                })
            );
            rock.position.set(
                -2.2 + Math.random() * 4.4, 0.2 + Math.random() * 3.3, -0.0
            );
            group.add(rock);
        }

        // 前面の柱（屋根を支える）
        for (const px of [-2.4, 2.4]) {
            const post = new THREE.Mesh(
                new THREE.CylinderGeometry(0.12, 0.14, 2.8, 6), woodMat
            );
            post.position.set(px, 1.4, 1.2);
            group.add(post);
        }

        // 大きな縞オーニング（赤×黄）
        const awning = this._buildStripedAwning(5.2, 2.4, 0xCB3E1A, 0xF0D260, 10);
        awning.position.set(0, 2.85, 0.6);
        awning.rotation.x = -0.28;
        group.add(awning);

        // カウンター
        const counter = new THREE.Mesh(
            new THREE.BoxGeometry(4.8, 0.7, 1.0), woodMat
        );
        counter.position.set(0, 0.35, 1.1);
        group.add(counter);

        // カウンター上の果物ピラミッド
        const fruitPalette = [
            { color: 0xE87838, ems: 0x4a1a08 },   // オレンジ
            { color: 0xD8422A, ems: 0x4a0a04 },   // トマト/ザクロ
            { color: 0xEBC44A, ems: 0x4a3010 },   // レモン
            { color: 0x6BA838, ems: 0x1a3a08 },   // ライム/スイカ
        ];
        for (let col = 0; col < 4; col++) {
            const fp = fruitPalette[col];
            const fx = -1.8 + col * 1.2;
            // ピラミッド3段
            for (let layer2 = 0; layer2 < 3; layer2++) {
                const count = 3 - layer2;
                for (let k = 0; k < count; k++) {
                    const fruit = new THREE.Mesh(
                        new THREE.SphereGeometry(0.12, 6, 5),
                        new THREE.MeshStandardMaterial({
                            color: fp.color, roughness: 0.7,
                            emissive: fp.ems, emissiveIntensity: 0.15,
                        })
                    );
                    fruit.position.set(
                        fx + (k - (count - 1) / 2) * 0.22 + layer2 * 0.05,
                        0.83 + layer2 * 0.2,
                        1.1 + (Math.random() - 0.5) * 0.1
                    );
                    group.add(fruit);
                }
            }
        }

        // 吊りランタン×3
        for (const lx of [-1.6, 0, 1.6]) {
            const str = new THREE.Mesh(
                new THREE.CylinderGeometry(0.015, 0.015, 0.35, 3),
                new THREE.MeshStandardMaterial({ color: 0x3A2A1A })
            );
            str.position.set(lx, 2.3, 1.1);
            group.add(str);
            const lantern = new THREE.Mesh(
                new THREE.CylinderGeometry(0.13, 0.16, 0.35, 8),
                new THREE.MeshStandardMaterial({
                    color: 0xFFCC66, emissive: 0xE8A024,
                    emissiveIntensity: 0.55, roughness: 0.5,
                })
            );
            lantern.position.set(lx, 1.95, 1.1);
            group.add(lantern);
            // 上下のキャップ
            const cap = new THREE.Mesh(
                new THREE.CylinderGeometry(0.08, 0.13, 0.06, 8),
                new THREE.MeshStandardMaterial({ color: 0x5A3A1A })
            );
            cap.position.set(lx, 2.15, 1.1);
            group.add(cap);
        }

        // 脇に置かれた編み籠（ナツメヤシの実などの大容器）
        for (const bx of [-2.7, 2.7]) {
            const basket = new THREE.Mesh(
                new THREE.CylinderGeometry(0.38, 0.32, 0.5, 10),
                new THREE.MeshStandardMaterial({ color: 0x6A4822, roughness: 0.95 })
            );
            basket.position.set(bx, 0.25, 1.3);
            group.add(basket);
            for (let f = 0; f < 6; f++) {
                const d2 = new THREE.Mesh(
                    new THREE.SphereGeometry(0.08, 5, 4),
                    new THREE.MeshStandardMaterial({
                        color: bx < 0 ? 0x5A2E12 : 0xB83A18,
                        roughness: 0.8,
                    })
                );
                d2.position.set(
                    bx + (Math.random() - 0.5) * 0.4,
                    0.55 + (Math.random() - 0.5) * 0.05,
                    1.3 + (Math.random() - 0.5) * 0.4
                );
                group.add(d2);
            }
        }

        // バザール正面の小さな書法看板
        const sign = this._buildCalligraphyBanner(2.0, 0.4, 3.7, 0.2);
        group.add(sign);
    }

    /* --- 大モスク（中央オニオンドーム＋4隅ミナレット） --- */
    _buildGrandMosque(group) {
        const wallMat = new THREE.MeshStandardMaterial({
            color: 0xE8C896, roughness: 0.92,
        });
        const wallMatDk = new THREE.MeshStandardMaterial({
            color: 0xB89366, roughness: 0.92,
        });
        const trimMat = new THREE.MeshStandardMaterial({
            color: 0x7A4A2A, roughness: 0.85,
        });
        const domeColor = 0x8C3B1C;

        const w = 8.5, h = 3.8, d = 4.5;

        // 基壇
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(w + 1.0, 0.35, d + 0.6), trimMat
        );
        base.position.y = 0.17;
        group.add(base);

        // 本体
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
        body.position.y = 0.35 + h / 2;
        group.add(body);

        // 装飾帯（青タイル）
        const blueBand = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.05, 0.4, d + 0.05),
            new THREE.MeshStandardMaterial({ color: 0x2B4E7A, roughness: 0.5 })
        );
        blueBand.position.y = 0.35 + h * 0.85;
        group.add(blueBand);

        // コーニス上段
        const cornice = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.5, 0.25, d + 0.4), trimMat
        );
        cornice.position.y = 0.35 + h + 0.12;
        group.add(cornice);

        // 胸壁
        for (let cx = -w / 2 + 0.4; cx < w / 2; cx += 0.7) {
            const merlon = new THREE.Mesh(
                new THREE.BoxGeometry(0.35, 0.35, 0.35), wallMatDk
            );
            merlon.position.set(cx, 0.35 + h + 0.42, d / 2 + 0.15);
            group.add(merlon);
        }

        // 中央の大きな尖頭アーチ入り口（イワン）
        const iwan = this._buildPointedArch(2.2, 3.2, 0.2, 0x1A0F08);
        iwan.position.set(0, 0.35, d / 2 + 0.02);
        group.add(iwan);

        // イワンの枠
        const iwanFrameV = new THREE.MeshStandardMaterial({ color: 0x5A3A1A, roughness: 0.85 });
        for (const sx of [-1.25, 1.25]) {
            const fv = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.2, 0.18), iwanFrameV);
            fv.position.set(sx, 0.35 + 1.6, d / 2 + 0.12);
            group.add(fv);
        }

        // 中央大ドームのドラム
        const mainDrum = new THREE.Mesh(
            new THREE.CylinderGeometry(1.6, 1.75, 1.0, 16), trimMat
        );
        mainDrum.position.y = 0.35 + h + 0.8;
        group.add(mainDrum);
        // ドラムの尖頭アーチ窓
        for (let ang = 0; ang < Math.PI * 2; ang += Math.PI / 6) {
            const slit = new THREE.Mesh(
                new THREE.BoxGeometry(0.2, 0.55, 0.08),
                new THREE.MeshStandardMaterial({ color: 0x1A1208 })
            );
            slit.position.set(
                Math.cos(ang) * 1.76, 0.35 + h + 0.8, Math.sin(ang) * 1.76
            );
            slit.rotation.y = -ang + Math.PI / 2;
            group.add(slit);
        }

        // 中央大オニオンドーム
        const mainDome = this._buildOnionDome(1.9, 4.8, domeColor, 20);
        mainDome.position.y = 0.35 + h + 1.3;
        group.add(mainDome);
        // リブ
        for (let r = 0; r < 12; r++) {
            const ang = (r / 12) * Math.PI * 2;
            const rib = new THREE.Mesh(
                new THREE.BoxGeometry(0.05, 4.3, 0.05),
                new THREE.MeshStandardMaterial({ color: 0x4E2010, roughness: 0.85 })
            );
            rib.position.set(Math.cos(ang) * 1.6, 0.35 + h + 3.2, Math.sin(ang) * 1.6);
            rib.rotation.z = 0.06 * Math.cos(ang);
            rib.rotation.x = 0.06 * Math.sin(ang);
            group.add(rib);
        }
        group.add(this._buildDomeFinial(0.35 + h + 6.1));

        // 脇の小ドーム（2つ）
        for (const sx of [-3.2, 3.2]) {
            const sDrum = new THREE.Mesh(
                new THREE.CylinderGeometry(0.75, 0.85, 0.5, 12), trimMat
            );
            sDrum.position.set(sx, 0.35 + h + 0.4, 0);
            group.add(sDrum);
            const sDome = this._buildOnionDome(0.9, 2.3, domeColor, 14);
            sDome.position.set(sx, 0.35 + h + 0.65, 0);
            group.add(sDome);
            for (let r = 0; r < 8; r++) {
                const ang = (r / 8) * Math.PI * 2;
                const rib = new THREE.Mesh(
                    new THREE.BoxGeometry(0.03, 2.1, 0.03),
                    new THREE.MeshStandardMaterial({ color: 0x4E2010 })
                );
                rib.position.set(sx + Math.cos(ang) * 0.78, 0.35 + h + 1.55, Math.sin(ang) * 0.78);
                group.add(rib);
            }
            group.add(this._buildDomeFinial(0.35 + h + 2.95, sx));
        }

        // 4隅のミナレット
        for (const mx of [-w / 2 - 0.4, w / 2 + 0.4]) {
            // 基段
            const mBase = new THREE.Mesh(
                new THREE.BoxGeometry(0.9, 0.8, 0.9), trimMat
            );
            mBase.position.set(mx, 0.4, 0);
            group.add(mBase);
            // 本体（8角）
            const shaft = new THREE.Mesh(
                new THREE.CylinderGeometry(0.4, 0.48, 6.0, 8), wallMat
            );
            shaft.position.set(mx, 3.8, 0);
            group.add(shaft);
            // 青タイル帯
            const mBand = new THREE.Mesh(
                new THREE.CylinderGeometry(0.43, 0.43, 0.25, 8),
                new THREE.MeshStandardMaterial({ color: 0x2B4E7A, roughness: 0.5 })
            );
            mBand.position.set(mx, 2.8, 0);
            group.add(mBand);
            // バルコニー
            const balcony = new THREE.Mesh(
                new THREE.CylinderGeometry(0.68, 0.68, 0.22, 8), trimMat
            );
            balcony.position.set(mx, 6.9, 0);
            group.add(balcony);
            // バルコニー手すり
            for (let bi = 0; bi < 8; bi++) {
                const ang = (bi / 8) * Math.PI * 2;
                const bal = new THREE.Mesh(
                    new THREE.BoxGeometry(0.04, 0.28, 0.04),
                    new THREE.MeshStandardMaterial({ color: 0x3A2A1A })
                );
                bal.position.set(mx + Math.cos(ang) * 0.65, 7.15, Math.sin(ang) * 0.65);
                group.add(bal);
            }
            // 上部シャフト
            const shaftU = new THREE.Mesh(
                new THREE.CylinderGeometry(0.32, 0.38, 1.3, 8), wallMatDk
            );
            shaftU.position.set(mx, 7.75, 0);
            group.add(shaftU);
            // オニオン頭
            const mDome = this._buildOnionDome(0.5, 1.6, domeColor, 12);
            mDome.position.set(mx, 8.4, 0);
            group.add(mDome);
            group.add(this._buildDomeFinial(9.95, mx));
        }

        // 前面のアーチ連（ファサードの装飾）
        for (const ax of [-3.3, -2.0, 2.0, 3.3]) {
            const arch = this._buildPointedArch(0.7, 1.2, 0.08, 0x5A3A1A);
            arch.position.set(ax, 0.35 + 1.0, d / 2 + 0.03);
            group.add(arch);
            // 内側の暗い開口
            const inner = new THREE.Mesh(
                new THREE.BoxGeometry(0.5, 0.8, 0.05),
                new THREE.MeshStandardMaterial({ color: 0x1E1008 })
            );
            inner.position.set(ax, 0.35 + 1.1, d / 2 + 0.08);
            group.add(inner);
        }

        // 入り口上の大きな書法バナー
        const mBanner = this._buildCalligraphyBanner(2.6, 0.55, 0.35 + 3.55, d / 2 + 0.1);
        group.add(mBanner);
    }

    /* --- アラビア風の門（装飾アーチ＋旗） --- */
    _buildArabianGate(group) {
        const wallMat = new THREE.MeshStandardMaterial({
            color: 0xCFA870, roughness: 0.92,
        });
        const trimMat = new THREE.MeshStandardMaterial({
            color: 0x7A4A2A, roughness: 0.85,
        });

        // 左右の塔
        for (const sx of [-2.4, 2.4]) {
            const tw = new THREE.Mesh(
                new THREE.BoxGeometry(1.6, 5.5, 1.6), wallMat
            );
            tw.position.set(sx, 2.75, 0);
            group.add(tw);
            // 胸壁
            for (let cx = -0.6; cx <= 0.6; cx += 0.6) {
                for (let cz of [-0.6, 0.6]) {
                    const m = new THREE.Mesh(
                        new THREE.BoxGeometry(0.35, 0.5, 0.35), trimMat
                    );
                    m.position.set(sx + cx, 5.75, cz);
                    group.add(m);
                }
            }
            // 塔の窓スリット
            for (let y = 1.8; y < 5; y += 1.0) {
                const slit = new THREE.Mesh(
                    new THREE.BoxGeometry(0.3, 0.6, 0.08),
                    new THREE.MeshStandardMaterial({ color: 0x1A0F08 })
                );
                slit.position.set(sx, y, 0.82);
                group.add(slit);
            }
            // 小オニオン頭
            const dome = this._buildOnionDome(0.55, 1.7, 0x8C3B1C, 14);
            dome.position.set(sx, 5.9, 0);
            group.add(dome);
            group.add(this._buildDomeFinial(7.6, sx));
        }

        // 中央の連結部（アーチの上の壁）
        const arch = new THREE.Mesh(
            new THREE.BoxGeometry(3.6, 2.2, 1.2), wallMat
        );
        arch.position.set(0, 4.9, 0);
        group.add(arch);
        // アーチ開口（尖頭）
        const archOpen = this._buildPointedArch(2.4, 3.8, 1.3, 0x1A0F08);
        archOpen.position.set(0, 0, 0);
        group.add(archOpen);

        // 中央上の書法バナー
        const banner = this._buildCalligraphyBanner(3.2, 0.7, 5.2, 0.62);
        group.add(banner);

        // 旗（三角ペナント、左右塔頂に1本ずつ）
        const flagMat = new THREE.MeshStandardMaterial({
            color: 0x2E7A8A, roughness: 0.8, side: THREE.DoubleSide,
        });
        for (const sx of [-2.4, 2.4]) {
            const pole = new THREE.Mesh(
                new THREE.CylinderGeometry(0.04, 0.04, 1.8, 4),
                new THREE.MeshStandardMaterial({ color: 0x3A2A1A })
            );
            pole.position.set(sx, 8.5, 0);
            group.add(pole);
            const flagShape = new THREE.Shape();
            flagShape.moveTo(0, 0);
            flagShape.lineTo(1.0, -0.15);
            flagShape.lineTo(0, -0.5);
            const flagGeo = new THREE.ShapeGeometry(flagShape);
            const flag = new THREE.Mesh(flagGeo, flagMat);
            flag.position.set(sx + 0.04, 9.3, 0);
            group.add(flag);
        }

        // 装飾タイル帯
        const tileBand = new THREE.Mesh(
            new THREE.BoxGeometry(3.6, 0.25, 1.22),
            new THREE.MeshStandardMaterial({ color: 0x2B4E7A, roughness: 0.5 })
        );
        tileBand.position.set(0, 4.2, 0);
        group.add(tileBand);
    }

    _buildStoneBuilding(group) {
        // Metal Slug風の石造りヨーロッパ建物
        const w = 4 + Math.random() * 3;
        const h = 5 + Math.random() * 4;
        const stoneColor = [0x9B8B7B, 0x8B7B6B, 0xA09080][Math.floor(Math.random() * 3)];

        // 本体
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, 3),
            new THREE.MeshStandardMaterial({ color: stoneColor, roughness: 0.9 })
        );
        body.position.y = h / 2;
        group.add(body);

        // 瓦屋根
        const roofShape = new THREE.Shape();
        roofShape.moveTo(-w / 2 - 0.5, 0);
        roofShape.lineTo(0, 2.0);
        roofShape.lineTo(w / 2 + 0.5, 0);
        const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 3.5, bevelEnabled: false });
        const roofColors = [0x8B3A1A, 0x7B4A2A, 0x6B3A1A];
        const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({
            color: roofColors[Math.floor(Math.random() * roofColors.length)],
            roughness: 0.85,
        }));
        roof.position.set(0, h, -1.75);
        group.add(roof);

        // 窓（アーチ型風）
        const winMat = new THREE.MeshStandardMaterial({ color: 0x1A1A2A, roughness: 0.3 });
        const frameMat = new THREE.MeshStandardMaterial({ color: 0x5A4A3A, roughness: 0.7 });
        for (let wy = 2; wy < h - 1; wy += 2.5) {
            for (let wx = -w / 3; wx <= w / 3; wx += w / 2.5) {
                if (Math.random() > 0.2) {
                    // 窓枠
                    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, 0.15), frameMat);
                    frame.position.set(wx, wy, 1.55);
                    group.add(frame);
                    // 窓ガラス（暗い）
                    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.65, 1.0, 0.1), winMat);
                    glass.position.set(wx, wy, 1.6);
                    group.add(glass);
                }
            }
        }

        // ドア
        const door = new THREE.Mesh(
            new THREE.BoxGeometry(1.0, 1.8, 0.15),
            new THREE.MeshStandardMaterial({ color: 0x4A3A2A, roughness: 0.8 })
        );
        door.position.set(0, 0.9, 1.55);
        group.add(door);
    }

    _buildWatchTower(group) {
        // 監視塔（Metal Slug定番）
        const towerMat = new THREE.MeshStandardMaterial({
            color: 0x7B6B5B, roughness: 0.85, metalness: 0.1,
        });
        // 塔本体
        const tower = new THREE.Mesh(new THREE.BoxGeometry(2.5, 10, 2.5), towerMat);
        tower.position.y = 5;
        group.add(tower);

        // 見張り台
        const platform = new THREE.Mesh(
            new THREE.BoxGeometry(3.5, 0.3, 3.5),
            new THREE.MeshStandardMaterial({ color: 0x6B5B4B, roughness: 0.8 })
        );
        platform.position.y = 10.2;
        group.add(platform);

        // 手すり
        const railMat = new THREE.MeshStandardMaterial({ color: 0x5A5A5A, metalness: 0.3 });
        for (let side of [-1.7, 1.7]) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 3.5), railMat);
            rail.position.set(side, 10.8, 0);
            group.add(rail);
            const rail2 = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.06, 1.0), railMat);
            rail2.position.set(0, 10.8, side);
            group.add(rail2);
        }

        // 窓スリット
        const slitMat = new THREE.MeshStandardMaterial({ color: 0x1A1A1A });
        for (let y = 3; y <= 8; y += 2.5) {
            const slit = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.3), slitMat);
            slit.position.set(0, y, 1.3);
            group.add(slit);
        }

        // サーチライト
        const lightGeo = new THREE.CylinderGeometry(0.15, 0.25, 0.5, 8);
        const light = new THREE.Mesh(lightGeo, new THREE.MeshStandardMaterial({
            color: 0xAAAA55, roughness: 0.3, metalness: 0.5,
        }));
        light.position.set(1.8, 10.5, 0);
        light.rotation.z = Math.PI / 4;
        group.add(light);
    }

    _buildSteelFrame(group) {
        // 鉄骨構造物（建設中/破壊された）
        const steelMat = new THREE.MeshStandardMaterial({
            color: 0x6A5A4A, roughness: 0.5, metalness: 0.5,
        });
        const h = 6 + Math.random() * 5;

        // 柱
        for (let x of [-2, 2]) {
            for (let z of [-1, 1]) {
                const col = new THREE.Mesh(
                    new THREE.BoxGeometry(0.2, h, 0.2),
                    steelMat
                );
                col.position.set(x, h / 2, z);
                group.add(col);
            }
        }

        // 横梁
        for (let y = 2; y <= h; y += 2.5) {
            const beam1 = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.15, 0.15), steelMat);
            beam1.position.set(0, y, -1);
            group.add(beam1);
            const beam2 = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.15, 0.15), steelMat);
            beam2.position.set(0, y, 1);
            group.add(beam2);
            // 斜め筋交い
            if (Math.random() > 0.4) {
                const brace = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3.5, 0.08), steelMat);
                brace.position.set(Math.random() > 0.5 ? -2 : 2, y, 0);
                brace.rotation.z = 0.6 * (Math.random() > 0.5 ? 1 : -1);
                group.add(brace);
            }
        }

        // 階段
        const stairMat = new THREE.MeshStandardMaterial({ color: 0x5A4A3A, metalness: 0.4 });
        for (let s = 0; s < 5; s++) {
            const step = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.4), stairMat);
            step.position.set(-2.5 + s * 0.5, 0.5 + s * 0.5, 0);
            step.rotation.z = -0.15;
            group.add(step);
        }
    }

    _buildWarehouse(group) {
        const w = 6 + Math.random() * 3;
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(w, 3.5, 4),
            new THREE.MeshStandardMaterial({ color: 0x6B7B6B, roughness: 0.8 })
        );
        body.position.y = 1.75;
        group.add(body);

        // 波板屋根
        const roofGeo = new THREE.CylinderGeometry(w / 2 + 0.3, w / 2 + 0.3, 4.5, 8, 1, false, 0, Math.PI);
        const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({
            color: 0x7B7B7B, roughness: 0.6, metalness: 0.3,
        }));
        roof.position.set(0, 3.5, 0);
        roof.rotation.z = Math.PI / 2;
        group.add(roof);

        // シャッター
        const shutter = new THREE.Mesh(
            new THREE.BoxGeometry(2.5, 2.8, 0.1),
            new THREE.MeshStandardMaterial({ color: 0x5A5A5A, roughness: 0.5, metalness: 0.4 })
        );
        shutter.position.set(0, 1.4, 2.05);
        group.add(shutter);
    }

    _buildFortWall(group) {
        // 石壁の要塞
        const wallLen = 8 + Math.random() * 6;
        const wallH = 3 + Math.random() * 2;
        const wallMat = new THREE.MeshStandardMaterial({
            color: 0x8B7B6B, roughness: 0.95,
        });
        const wall = new THREE.Mesh(new THREE.BoxGeometry(wallLen, wallH, 1.5), wallMat);
        wall.position.y = wallH / 2;
        group.add(wall);

        // 胸壁（凹凸のある上部）
        for (let x = -wallLen / 2 + 0.5; x < wallLen / 2; x += 1.5) {
            if (Math.random() > 0.3) {
                const merlon = new THREE.Mesh(
                    new THREE.BoxGeometry(0.8, 0.8, 1.6),
                    wallMat
                );
                merlon.position.set(x, wallH + 0.4, 0);
                group.add(merlon);
            }
        }

        // 銃眼
        const slitMat = new THREE.MeshStandardMaterial({ color: 0x1A1A1A });
        for (let x = -wallLen / 3; x <= wallLen / 3; x += wallLen / 3) {
            const slit = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.3), slitMat);
            slit.position.set(x, wallH * 0.6, 0.8);
            group.add(slit);
        }
    }

    /* --- 砂漠の遺跡（崩れた柱と石壁） --- */
    _buildDesertRuins(group) {
        const stoneMat = new THREE.MeshStandardMaterial({
            color: 0xC9A876, roughness: 0.95, metalness: 0.0, flatShading: true,
        });
        const stoneMatDk = new THREE.MeshStandardMaterial({
            color: 0xA0845A, roughness: 0.95, flatShading: true,
        });

        // 崩れた石の基壇
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(7, 0.6, 3),
            stoneMatDk
        );
        base.position.y = 0.3;
        group.add(base);

        // 複数の柱（一部は折れている）
        const columnCount = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < columnCount; i++) {
            const isBroken = Math.random() > 0.5;
            const h = isBroken ? (1 + Math.random() * 2) : (4 + Math.random() * 2);
            // 柱本体（溝付きの円柱）
            const col = new THREE.Mesh(
                new THREE.CylinderGeometry(0.35, 0.4, h, 10),
                stoneMat
            );
            col.position.set(-3 + i * 1.5, h / 2 + 0.6, 0);
            group.add(col);

            // 柱頭
            if (!isBroken) {
                const cap = new THREE.Mesh(
                    new THREE.BoxGeometry(0.9, 0.2, 0.9),
                    stoneMatDk
                );
                cap.position.set(col.position.x, h + 0.7, 0);
                group.add(cap);
                // 上部装飾
                const capTop = new THREE.Mesh(
                    new THREE.BoxGeometry(0.75, 0.15, 0.75),
                    stoneMat
                );
                capTop.position.set(col.position.x, h + 0.85, 0);
                group.add(capTop);
            } else {
                // 折れた断面（斜め）
                const broken = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.38, 0.32, 0.1, 10),
                    stoneMatDk
                );
                broken.position.set(col.position.x, h + 0.65, 0);
                broken.rotation.z = (Math.random() - 0.5) * 0.3;
                group.add(broken);
            }
        }

        // 倒れた柱の破片
        for (let i = 0; i < 2; i++) {
            const piece = new THREE.Mesh(
                new THREE.CylinderGeometry(0.3, 0.35, 1.2 + Math.random(), 8),
                stoneMat
            );
            piece.position.set(-2 + i * 2.5, 0.3, 1.8);
            piece.rotation.z = Math.PI / 2;
            piece.rotation.y = (Math.random() - 0.5) * 0.5;
            group.add(piece);
        }
    }

    /* --- オベリスク（エジプト風の尖塔） --- */
    _buildObelisk(group) {
        const stoneMat = new THREE.MeshStandardMaterial({
            color: 0xBEA56E, roughness: 0.9, flatShading: true,
        });
        const stoneMatDk = new THREE.MeshStandardMaterial({
            color: 0x8E7543, roughness: 0.9, flatShading: true,
        });

        // 基壇（3段）
        for (let tier = 0; tier < 3; tier++) {
            const size = 3.2 - tier * 0.5;
            const ht = 0.4;
            const step = new THREE.Mesh(
                new THREE.BoxGeometry(size, ht, size),
                tier % 2 === 0 ? stoneMat : stoneMatDk
            );
            step.position.y = tier * ht + ht / 2;
            group.add(step);
        }

        // メインのオベリスク本体
        const obeliskHeight = 9 + Math.random() * 3;
        const shaft = new THREE.Mesh(
            new THREE.CylinderGeometry(0.4, 0.65, obeliskHeight, 4),
            stoneMat
        );
        shaft.position.y = 1.2 + obeliskHeight / 2;
        shaft.rotation.y = Math.PI / 4;
        group.add(shaft);

        // 頂上ピラミッド
        const tip = new THREE.Mesh(
            new THREE.ConeGeometry(0.5, 1.0, 4),
            stoneMatDk
        );
        tip.position.y = 1.2 + obeliskHeight + 0.5;
        tip.rotation.y = Math.PI / 4;
        group.add(tip);

        // 風化の亀裂（側面の暗い帯）
        for (let k = 0; k < 2; k++) {
            const crack = new THREE.Mesh(
                new THREE.BoxGeometry(0.03, obeliskHeight * 0.6, 0.03),
                new THREE.MeshBasicMaterial({ color: 0x5a4520 })
            );
            crack.position.set(0.42, 2 + k * 2, 0);
            group.add(crack);
        }
    }

    /* --- 砂漠の寺院（アラブ風のドーム建造物） --- */
    _buildDesertTemple(group) {
        const wallMat = new THREE.MeshStandardMaterial({
            color: 0xD6B88C, roughness: 0.9,
        });
        const domeMat = new THREE.MeshStandardMaterial({
            color: 0x9E8560, roughness: 0.7, metalness: 0.1,
        });
        const trimMat = new THREE.MeshStandardMaterial({
            color: 0x7A5F3A, roughness: 0.8,
        });

        // 基壇
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(6, 0.5, 4),
            trimMat
        );
        base.position.y = 0.25;
        group.add(base);

        // 本体
        const w = 5;
        const h = 3.5;
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, 3.5),
            wallMat
        );
        body.position.y = 0.5 + h / 2;
        group.add(body);

        // 中央のアーチ入り口（暗い長方形）
        const arch = new THREE.Mesh(
            new THREE.BoxGeometry(1.0, 1.8, 0.1),
            new THREE.MeshStandardMaterial({ color: 0x2B1A0F, roughness: 0.4 })
        );
        arch.position.set(0, 1.4, 1.76);
        group.add(arch);
        // アーチ上部（曲線を模倣）
        const archTop = new THREE.Mesh(
            new THREE.SphereGeometry(0.5, 8, 6, 0, Math.PI),
            new THREE.MeshStandardMaterial({ color: 0x2B1A0F, roughness: 0.4 })
        );
        archTop.rotation.x = -Math.PI / 2;
        archTop.rotation.y = Math.PI;
        archTop.position.set(0, 2.3, 1.76);
        archTop.scale.set(1, 1, 0.3);
        group.add(archTop);

        // サイドウィンドウ（小さい暗窓）
        for (let sx of [-1.6, 1.6]) {
            const win = new THREE.Mesh(
                new THREE.BoxGeometry(0.5, 0.8, 0.1),
                new THREE.MeshStandardMaterial({ color: 0x1A1020 })
            );
            win.position.set(sx, 2.4, 1.76);
            group.add(win);
        }

        // 屋根のトリム
        const trim = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.3, 0.3, 3.8),
            trimMat
        );
        trim.position.y = 0.5 + h + 0.15;
        group.add(trim);

        // メインドーム
        const dome = new THREE.Mesh(
            new THREE.SphereGeometry(1.8, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
            domeMat
        );
        dome.position.y = 0.5 + h + 0.3;
        group.add(dome);

        // ドーム頂上の月柱（三日月の簡易表現）
        const spire = new THREE.Mesh(
            new THREE.CylinderGeometry(0.04, 0.05, 0.8, 6),
            new THREE.MeshStandardMaterial({ color: 0xDAA850, metalness: 0.6, roughness: 0.3 })
        );
        spire.position.y = 0.5 + h + 2.1;
        group.add(spire);

        // 両脇のミナレット（小塔）
        for (let mx of [-2.4, 2.4]) {
            const tower = new THREE.Mesh(
                new THREE.CylinderGeometry(0.35, 0.4, 5, 8),
                wallMat
            );
            tower.position.set(mx, 2.5, 0);
            group.add(tower);

            const towerDome = new THREE.Mesh(
                new THREE.SphereGeometry(0.45, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
                domeMat
            );
            towerDome.position.set(mx, 5.0, 0);
            group.add(towerDome);
        }
    }

    /* --- Layer 4: 近景の鉄骨・電柱・看板 --- */
    _buildForegroundStructures(zPos, parallaxRate) {
        const layer = { objects: [], parallaxRate, zPos };
        for (let i = -3; i <= 7; i++) {
            const pGroup = new THREE.Group();
            const r = Math.random();
            // 前景：ジオラマの生活感（物干し・陶器棚）を加えてバラエティアップ
            if (r < 0.18) {
                this._buildHangingLaundry(pGroup);
            } else if (r < 0.30) {
                this._buildPotteryShelf(pGroup);
            } else if (r < 0.42) {
                this._buildAcaciaTree(pGroup);
            } else if (r < 0.52) {
                this._buildWoodenScaffold(pGroup);
            } else if (r < 0.60) {
                this._buildThatchedHut(pGroup, {
                    radius: 1.6 + Math.random() * 0.5,
                    wallH: 1.4 + Math.random() * 0.4,
                    roofH: 2.6 + Math.random() * 0.6,
                });
            } else if (r < 0.68) {
                this._buildPalmTree(pGroup);
            } else if (r < 0.74) {
                this._buildVillageWell(pGroup);
            } else if (r < 0.80) {
                this._buildWreckage(pGroup);
            } else if (r < 0.85) {
                this._buildPowerPole(pGroup);
            } else if (r < 0.90) {
                this._buildMilitarySign(pGroup);
            } else if (r < 0.95) {
                this._buildMarketCanopy(pGroup);
            } else {
                this._buildHangingScimitar(pGroup);
            }

            pGroup.position.set(
                i * 18 + (Math.random() - 0.5) * 8,
                0,
                zPos + (Math.random() - 0.5) * 3
            );
            this.scene.add(pGroup);
            layer.objects.push(pGroup);
        }
        this.bgLayers.push(layer);
    }

    /** ヤシの木 — 節のある曲がった幹 + 葉軸＋小葉で表現したフロンド */
    _buildPalmTree(group) {
        // 幹（節リング付き、ゆるく曲がる）
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7A5A2E, roughness: 0.95 });
        const ringMat = new THREE.MeshStandardMaterial({ color: 0x4A3010, roughness: 1.0 });
        const segments = 5;
        let prevY = 0;
        let prevX = 0;
        const lean = (Math.random() - 0.5) * 0.45;
        for (let s = 0; s < segments; s++) {
            const segH = 1.5 + Math.random() * 0.45;
            const topR = Math.max(0.16 - s * 0.022, 0.09);
            const botR = Math.max(0.22 - s * 0.022, 0.11);
            const cx = prevX + lean * s * 0.32;
            const seg = new THREE.Mesh(
                new THREE.CylinderGeometry(topR, botR, segH, 8),
                trunkMat
            );
            seg.position.set(cx, prevY + segH / 2, 0);
            seg.rotation.z = lean * s * 0.16;
            group.add(seg);

            // 節リング（ヤシ特有の節）
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(botR + 0.015, 0.025, 4, 10),
                ringMat
            );
            ring.position.set(cx - lean * 0.1, prevY + 0.04, 0);
            ring.rotation.x = Math.PI / 2;
            group.add(ring);

            prevY += segH;
            prevX += lean * 0.32;
        }
        const topX = prevX + lean * 0.4;
        const topY = prevY;

        // 王冠（葉柄基部）
        const crown = new THREE.Mesh(
            new THREE.SphereGeometry(0.24, 10, 6),
            new THREE.MeshStandardMaterial({ color: 0x6A4A20, roughness: 0.9 })
        );
        crown.position.set(topX, topY + 0.05, 0);
        crown.scale.set(1, 0.55, 1);
        group.add(crown);

        // フロンド（葉軸 + 両側に小葉）
        const leafColors = [0x2F6020, 0x3F7A28, 0x357024];
        const rachisMat = new THREE.MeshStandardMaterial({ color: 0x4A6A2A, roughness: 0.9 });
        const fronds = 9 + Math.floor(Math.random() * 3);
        const baseDroop = 0.55 + Math.random() * 0.2;
        const leafletGeo = new THREE.PlaneGeometry(0.16, 0.7);
        for (let i = 0; i < fronds; i++) {
            const angle = (i / fronds) * Math.PI * 2 + Math.random() * 0.18;
            const droop = baseDroop + (Math.random() - 0.5) * 0.15;
            const leafMat = new THREE.MeshStandardMaterial({
                color: leafColors[i % leafColors.length],
                roughness: 0.85, side: THREE.DoubleSide, flatShading: true,
            });

            const frond = new THREE.Group();
            const rachisLen = 2.4 + Math.random() * 0.5;

            // 葉軸（外向きに伸びて先端で垂れる）
            const rachis = new THREE.Mesh(
                new THREE.CylinderGeometry(0.025, 0.045, rachisLen, 5),
                rachisMat
            );
            rachis.rotation.z = -Math.PI / 2;
            rachis.position.set(rachisLen * 0.5, 0, 0);
            // 葉軸を少し下方に傾ける
            const rachisPivot = new THREE.Group();
            rachisPivot.add(rachis);
            rachisPivot.rotation.z = -droop * 0.4;
            frond.add(rachisPivot);

            // 小葉（左右ペアで葉軸に沿って配置）
            const pairs = 7;
            for (let k = 1; k <= pairs; k++) {
                const t = k / (pairs + 1);
                const along = t * rachisLen;
                const sag = -Math.sin(t * Math.PI * 0.6) * droop * rachisLen * 0.45;
                const leafLen = 0.85 - t * 0.35;
                for (const side of [1, -1]) {
                    const leaflet = new THREE.Mesh(leafletGeo, leafMat);
                    leaflet.scale.y = leafLen / 0.7;
                    leaflet.position.set(along, sag, side * 0.04);
                    leaflet.rotation.set(side * 0.55, 0, -Math.PI / 2 - 0.15 * side);
                    frond.add(leaflet);
                }
            }

            frond.position.set(topX, topY + 0.18, 0);
            frond.rotation.y = angle;
            group.add(frond);
        }

        // 実のバリエーション： ココナッツ / ナツメヤシ（濃茶） / オレンジの房
        const fruitVariant = Math.random();
        if (fruitVariant > 0.3) {
            if (fruitVariant > 0.7) {
                // オレンジの房
                for (let c = 0; c < 2; c++) {
                    const ca = (c / 2) * Math.PI * 2 + Math.random() * 0.5;
                    for (let f = 0; f < 7; f++) {
                        const orange = new THREE.Mesh(
                            new THREE.SphereGeometry(0.09, 5, 4),
                            new THREE.MeshStandardMaterial({
                                color: 0xE87838, roughness: 0.75,
                                emissive: 0x3a1a08, emissiveIntensity: 0.12,
                            })
                        );
                        orange.position.set(
                            topX + Math.cos(ca) * 0.3 + (Math.random() - 0.5) * 0.15,
                            topY - 0.15 - Math.random() * 0.35,
                            Math.sin(ca) * 0.3 + (Math.random() - 0.5) * 0.15
                        );
                        group.add(orange);
                    }
                }
            } else if (fruitVariant > 0.5) {
                // ナツメヤシの房
                for (let c = 0; c < 3; c++) {
                    const ca = (c / 3) * Math.PI * 2 + Math.random() * 0.3;
                    for (let f = 0; f < 10; f++) {
                        const date = new THREE.Mesh(
                            new THREE.SphereGeometry(0.05, 4, 3),
                            new THREE.MeshStandardMaterial({ color: 0x5A2E12, roughness: 0.85 })
                        );
                        date.position.set(
                            topX + Math.cos(ca) * 0.25 + (Math.random() - 0.5) * 0.12,
                            topY - 0.1 - Math.random() * 0.4,
                            Math.sin(ca) * 0.25 + (Math.random() - 0.5) * 0.12
                        );
                        group.add(date);
                    }
                }
            } else {
                // ココナッツ
                for (let c = 0; c < 3; c++) {
                    const coconut = new THREE.Mesh(
                        new THREE.SphereGeometry(0.13, 6, 4),
                        new THREE.MeshStandardMaterial({ color: 0x5A3A1A, roughness: 0.9 })
                    );
                    coconut.position.set(
                        topX + (Math.random() - 0.5) * 0.3,
                        topY - 0.2,
                        (Math.random() - 0.5) * 0.3
                    );
                    group.add(coconut);
                }
            }
        }
        return group;
    }

    _buildPowerPole(group) {
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x5A4A3A, roughness: 0.8 });
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 9, 6), poleMat);
        pole.position.y = 4.5;
        group.add(pole);

        // 横木（2段）
        for (let y of [7.5, 8.5]) {
            const cross = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.1, 0.1), poleMat);
            cross.position.y = y;
            group.add(cross);
        }

        // 碍子
        const insulatorMat = new THREE.MeshStandardMaterial({ color: 0xAABBAA, roughness: 0.4 });
        for (let y of [7.5, 8.5]) {
            for (let x of [-1.3, -0.4, 0.4, 1.3]) {
                const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.15, 6), insulatorMat);
                ins.position.set(x, y + 0.1, 0);
                group.add(ins);
            }
        }
    }

    _buildMilitarySign(group) {
        // 軍事看板
        const postMat = new THREE.MeshStandardMaterial({ color: 0x5A5A5A, metalness: 0.3 });
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 3, 6), postMat);
        post.position.y = 1.5;
        group.add(post);

        // 看板本体
        const signColors = [0x4A6B4A, 0x6B4A2A, 0x8B2020];
        const signColor = signColors[Math.floor(Math.random() * signColors.length)];
        const sign = new THREE.Mesh(
            new THREE.BoxGeometry(1.8, 1.0, 0.08),
            new THREE.MeshStandardMaterial({ color: signColor, roughness: 0.7 })
        );
        sign.position.y = 3.2;
        group.add(sign);

        // 矢印マーク
        const arrowMat = new THREE.MeshStandardMaterial({ color: 0xDDDD88 });
        const arrow = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.15, 0.1), arrowMat);
        arrow.position.set(0, 3.2, 0.05);
        group.add(arrow);
        const arrowHead = new THREE.Mesh(
            new THREE.ConeGeometry(0.2, 0.4, 3),
            arrowMat
        );
        arrowHead.position.set(0.6, 3.2, 0.05);
        arrowHead.rotation.z = -Math.PI / 2;
        group.add(arrowHead);
    }

    _buildWreckage(group) {
        const bodyGeo = new THREE.BoxGeometry(3.5, 1.3, 1.8);
        const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({
            color: 0x5A5A4A, roughness: 0.9, metalness: 0.1,
        }));
        body.position.y = 0.65;
        body.rotation.z = (Math.random() - 0.5) * 0.3;
        body.rotation.y = (Math.random() - 0.5) * 0.2;
        group.add(body);

        // タイヤ
        const tireMat = new THREE.MeshStandardMaterial({ color: 0x1A1A1A });
        for (let x of [-1.2, 1.2]) {
            const tire = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.14, 6, 8), tireMat);
            tire.position.set(x, 0.35, 1);
            tire.rotation.y = Math.PI / 2;
            group.add(tire);
        }

        // 焼け焦げ跡
        const scorch = new THREE.Mesh(
            new THREE.CircleGeometry(1.5, 8),
            new THREE.MeshStandardMaterial({ color: 0x2A2A2A, roughness: 1.0 })
        );
        scorch.rotation.x = -Math.PI / 2;
        scorch.position.y = 0.02;
        group.add(scorch);
    }

    _buildStreetLamp(group) {
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x4A4A4A, metalness: 0.4 });
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 5, 6), poleMat);
        pole.position.y = 2.5;
        group.add(pole);

        // 曲がったアーム
        const arm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.06), poleMat);
        arm.position.set(0.5, 5.0, 0);
        arm.rotation.z = -0.2;
        group.add(arm);

        // ランプ（壊れている）
        const lamp = new THREE.Mesh(
            new THREE.ConeGeometry(0.25, 0.4, 6),
            new THREE.MeshStandardMaterial({ color: 0x888866, roughness: 0.5 })
        );
        lamp.position.set(1.1, 4.8, 0);
        lamp.rotation.z = Math.PI;
        group.add(lamp);
    }

    _buildMarketCanopy(group) {
        const postMat = new THREE.MeshStandardMaterial({ color: 0x6A4A2A, roughness: 0.88 });
        const clothA = new THREE.MeshStandardMaterial({ color: 0xD84A2A, roughness: 0.92, side: THREE.DoubleSide });
        const clothB = new THREE.MeshStandardMaterial({ color: 0xE7CF8A, roughness: 0.92, side: THREE.DoubleSide });

        for (const x of [-1.15, 1.15]) {
            for (const z of [-0.75, 0.75]) {
                const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 2.2, 6), postMat);
                post.position.set(x, 1.1, z);
                group.add(post);
            }
        }

        for (let i = 0; i < 6; i++) {
            const cloth = new THREE.Mesh(
                new THREE.BoxGeometry(2.4, 0.06, 0.28),
                i % 2 === 0 ? clothA : clothB
            );
            cloth.position.set(0, 2.28 - i * 0.05, -0.7 + i * 0.28);
            group.add(cloth);
        }

        const table = new THREE.Mesh(
            new THREE.BoxGeometry(2.0, 0.1, 1.0),
            new THREE.MeshStandardMaterial({ color: 0x8A6338, roughness: 0.86 })
        );
        table.position.y = 0.85;
        group.add(table);

        const basketMat = new THREE.MeshStandardMaterial({ color: 0x7A4A28, roughness: 0.9 });
        for (const x of [-0.65, 0, 0.65]) {
            const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.2, 8), basketMat);
            basket.position.set(x, 0.98, 0);
            group.add(basket);
            for (let f = 0; f < 6; f++) {
                const fruit = new THREE.Mesh(
                    new THREE.SphereGeometry(0.07, 5, 4),
                    new THREE.MeshStandardMaterial({
                        color: f % 2 === 0 ? 0xE67A2E : 0xD2B04A,
                        roughness: 0.75,
                        emissive: 0x2A1408,
                        emissiveIntensity: 0.1,
                    })
                );
                fruit.position.set(
                    x + (Math.random() - 0.5) * 0.22,
                    1.08 + Math.random() * 0.06,
                    (Math.random() - 0.5) * 0.18
                );
                group.add(fruit);
            }
        }
    }

    _buildRuinedStatue(group) {
        const stone = new THREE.MeshStandardMaterial({ color: 0xB79A72, roughness: 0.95, flatShading: true });
        const stoneDark = new THREE.MeshStandardMaterial({ color: 0x8E7455, roughness: 0.95, flatShading: true });

        const base = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.45, 1.6), stoneDark);
        base.position.y = 0.225;
        group.add(base);

        const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.48, 1.4, 7), stone);
        torso.position.set(0, 1.2, 0);
        torso.rotation.z = (Math.random() - 0.5) * 0.18;
        group.add(torso);

        const head = new THREE.Mesh(new THREE.DodecahedronGeometry(0.34, 0), stone);
        head.position.set(0.05, 2.1, 0);
        group.add(head);

        const brokenArm = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.18, 0.22), stoneDark);
        brokenArm.position.set(0.4, 1.55, 0.18);
        brokenArm.rotation.z = -0.65;
        group.add(brokenArm);

        for (let i = 0; i < 7; i++) {
            const rubble = new THREE.Mesh(
                new THREE.DodecahedronGeometry(0.12 + Math.random() * 0.2, 0),
                Math.random() > 0.5 ? stone : stoneDark
            );
            rubble.position.set(
                (Math.random() - 0.5) * 2.4,
                0.08 + Math.random() * 0.18,
                (Math.random() - 0.5) * 1.4
            );
            rubble.rotation.set(Math.random(), Math.random(), Math.random());
            group.add(rubble);
        }
    }

    /* --- Layer 5: 最前景の瓦礫 --- */
    _buildNearForeground(zPos, parallaxRate) {
        const layer = { objects: [], parallaxRate, zPos };
        for (let i = -2; i <= 6; i++) {
            if (Math.random() > 0.4) {
                const dGroup = new THREE.Group();
                this._buildDebrisPile(dGroup);
                dGroup.position.set(
                    i * 20 + (Math.random() - 0.5) * 10,
                    0,
                    zPos + (Math.random() - 0.5) * 2
                );
                this.scene.add(dGroup);
                layer.objects.push(dGroup);
            }
        }
        this.bgLayers.push(layer);
    }

    _buildDebrisPile(group) {
        const debrisMat = new THREE.MeshStandardMaterial({
            color: 0x7B6B5B, roughness: 0.95,
        });
        const count = 3 + Math.floor(Math.random() * 5);
        for (let i = 0; i < count; i++) {
            const size = 0.3 + Math.random() * 0.8;
            const geo = Math.random() > 0.5
                ? new THREE.BoxGeometry(size, size * 0.6, size * 0.8)
                : new THREE.DodecahedronGeometry(size * 0.4, 0);
            const piece = new THREE.Mesh(geo, debrisMat);
            piece.position.set(
                (Math.random() - 0.5) * 3,
                size * 0.3,
                (Math.random() - 0.5) * 1.5
            );
            piece.rotation.set(
                Math.random() * 0.5,
                Math.random() * Math.PI,
                Math.random() * 0.5
            );
            group.add(piece);
        }

        // 鉄筋
        if (Math.random() > 0.5) {
            const rebarMat = new THREE.MeshStandardMaterial({
                color: 0x8B5A2B, roughness: 0.6, metalness: 0.4,
            });
            for (let r = 0; r < 2; r++) {
                const rebar = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.02, 0.02, 2 + Math.random(), 4),
                    rebarMat
                );
                rebar.position.set(
                    (Math.random() - 0.5) * 2,
                    0.5 + Math.random(),
                    (Math.random() - 0.5) * 1
                );
                rebar.rotation.z = (Math.random() - 0.5) * 1.5;
                rebar.rotation.x = (Math.random() - 0.5) * 0.5;
                group.add(rebar);
            }
        }
    }

    /* ========================================================
     *  AFRICAN VILLAGE - コンセプト画像 C0mVPN3lN3L6.png 準拠
     *  円錐茅葺き屋根の小屋、アカシア木、木製足場、土器、丸太柵
     * ======================================================== */

    /** 円錐茅葺き屋根の小屋（メタルスラッグ風アフリカ村） */
    _buildThatchedHut(group, opts = {}) {
        const radius = opts.radius || (1.4 + Math.random() * 0.7);
        const wallH = opts.wallH || (1.4 + Math.random() * 0.4);
        const roofH = opts.roofH || (radius * 1.7 + Math.random() * 0.4);

        // 土壁（クレイ／泥レンガ）— わずかに色をばらつかせる
        const wallColors = [0xC9A271, 0xB89060, 0xD4B080, 0xA88454, 0xC09668];
        const wallColor = wallColors[Math.floor(Math.random() * wallColors.length)];
        const wallMat = new THREE.MeshStandardMaterial({
            color: wallColor, roughness: 0.95, flatShading: true,
        });
        const wall = new THREE.Mesh(
            new THREE.CylinderGeometry(radius * 0.92, radius, wallH, 14),
            wallMat
        );
        wall.position.y = wallH / 2;
        wall.castShadow = true;
        wall.receiveShadow = true;
        group.add(wall);

        // 壁の縦溝（粘土を塗り重ねた質感）
        const grooveMat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(wallColor).multiplyScalar(0.78), roughness: 1.0,
        });
        const grooveCount = 8;
        for (let i = 0; i < grooveCount; i++) {
            const a = (i / grooveCount) * Math.PI * 2;
            const groove = new THREE.Mesh(
                new THREE.BoxGeometry(0.04, wallH * 0.85, 0.04),
                grooveMat
            );
            groove.position.set(
                Math.cos(a) * radius * 0.96,
                wallH / 2,
                Math.sin(a) * radius * 0.96
            );
            groove.rotation.y = -a;
            group.add(groove);
        }

        // 入口（暗い穴）
        const doorW = Math.min(0.55, radius * 0.45);
        const doorH = Math.min(1.0, wallH * 0.7);
        const door = new THREE.Mesh(
            new THREE.BoxGeometry(doorW, doorH, 0.08),
            new THREE.MeshStandardMaterial({ color: 0x0A0805, roughness: 1.0 })
        );
        const doorAngle = (Math.random() - 0.5) * 0.6;
        door.position.set(
            Math.cos(doorAngle) * radius * 0.96,
            doorH / 2,
            Math.sin(doorAngle) * radius * 0.96
        );
        door.rotation.y = -doorAngle;
        group.add(door);

        // 入口上の楣（木の梁）
        const lintelMat = new THREE.MeshStandardMaterial({ color: 0x4A2E18, roughness: 0.95 });
        const lintel = new THREE.Mesh(
            new THREE.BoxGeometry(doorW + 0.18, 0.1, 0.16),
            lintelMat
        );
        lintel.position.set(door.position.x, doorH + 0.05, door.position.z);
        lintel.rotation.y = -doorAngle;
        group.add(lintel);

        // 円錐茅葺き屋根（重ねた段で質感を出す）
        const roofColors = [0xC8A050, 0xB89048, 0xD8B060, 0xA88040];
        const roofColor = roofColors[Math.floor(Math.random() * roofColors.length)];
        const roofBaseR = radius * 1.18;
        const roofMat = new THREE.MeshStandardMaterial({
            color: roofColor, roughness: 1.0, flatShading: true,
        });
        const roofTiers = 4;
        for (let t = 0; t < roofTiers; t++) {
            const tBot = t / roofTiers;
            const tTop = (t + 1) / roofTiers;
            const rBot = roofBaseR * (1 - tBot * 0.95);
            const rTop = roofBaseR * (1 - tTop * 0.95);
            const yBot = wallH + roofH * tBot;
            const yTop = wallH + roofH * tTop;
            const tier = new THREE.Mesh(
                new THREE.CylinderGeometry(rTop, rBot, yTop - yBot, 16, 1, true),
                roofMat
            );
            tier.position.y = (yBot + yTop) / 2;
            tier.castShadow = true;
            group.add(tier);

            // 段の縁の藁の毛羽（小さなコーン群）
            if (t < roofTiers - 1) {
                const fringeCount = 16;
                const fringeMat = new THREE.MeshStandardMaterial({
                    color: new THREE.Color(roofColor).multiplyScalar(0.78), roughness: 1.0,
                });
                for (let f = 0; f < fringeCount; f++) {
                    const a = (f / fringeCount) * Math.PI * 2;
                    const fringe = new THREE.Mesh(
                        new THREE.ConeGeometry(0.08, 0.22, 4),
                        fringeMat
                    );
                    fringe.position.set(
                        Math.cos(a) * rBot * 1.02,
                        yBot + 0.04,
                        Math.sin(a) * rBot * 1.02
                    );
                    fringe.rotation.x = Math.PI; // 下向き
                    fringe.rotation.y = a;
                    group.add(fringe);
                }
            }
        }

        // 屋根の頂点キャップ（小さな束）
        const capMat = new THREE.MeshStandardMaterial({ color: 0x6A4220, roughness: 1.0 });
        const cap = new THREE.Mesh(
            new THREE.ConeGeometry(0.12, 0.45, 6),
            capMat
        );
        cap.position.y = wallH + roofH + 0.15;
        group.add(cap);

        // 屋根の骨組み（先端から放射状に出る木枝）
        const stickMat = new THREE.MeshStandardMaterial({ color: 0x3A2410, roughness: 1.0 });
        const stickCount = 6;
        for (let s = 0; s < stickCount; s++) {
            const a = (s / stickCount) * Math.PI * 2 + 0.2;
            const stick = new THREE.Mesh(
                new THREE.CylinderGeometry(0.025, 0.025, 0.5, 4),
                stickMat
            );
            stick.position.set(
                Math.cos(a) * roofBaseR * 0.05,
                wallH + roofH + 0.08,
                Math.sin(a) * roofBaseR * 0.05
            );
            stick.rotation.z = Math.PI / 2 - 0.5;
            stick.rotation.y = -a;
            group.add(stick);
        }

        return group;
    }

    /** アフリカ村の建物グループ（複数の小屋を寄り添わせて配置） */
    _buildVillageCluster(group) {
        const hutCount = 2 + Math.floor(Math.random() * 3);
        const placed = [];
        for (let i = 0; i < hutCount; i++) {
            const hut = new THREE.Group();
            this._buildThatchedHut(hut, {
                radius: 1.3 + Math.random() * 0.6,
                wallH: 1.3 + Math.random() * 0.4,
                roofH: 2.4 + Math.random() * 0.5,
            });
            // 既存小屋と重ならないようにスポット選び
            let tries = 0;
            let px, pz;
            do {
                px = (Math.random() - 0.5) * 6;
                pz = (Math.random() - 0.5) * 4;
                tries++;
            } while (
                tries < 8 &&
                placed.some(p => Math.hypot(p.x - px, p.z - pz) < 3.2)
            );
            hut.position.set(px, 0, pz);
            hut.rotation.y = Math.random() * Math.PI * 2;
            group.add(hut);
            placed.push({ x: px, z: pz });
        }

        // 中央に共有スペースの石組み焚き火跡
        if (Math.random() > 0.5) {
            const fireRing = new THREE.Group();
            const stoneMat = new THREE.MeshStandardMaterial({ color: 0x5A4A3A, roughness: 1.0, flatShading: true });
            for (let s = 0; s < 8; s++) {
                const a = (s / 8) * Math.PI * 2;
                const stone = new THREE.Mesh(
                    new THREE.DodecahedronGeometry(0.12, 0),
                    stoneMat
                );
                stone.position.set(Math.cos(a) * 0.45, 0.08, Math.sin(a) * 0.45);
                stone.rotation.set(Math.random(), Math.random(), Math.random());
                fireRing.add(stone);
            }
            const ash = new THREE.Mesh(
                new THREE.CylinderGeometry(0.32, 0.38, 0.04, 12),
                new THREE.MeshStandardMaterial({ color: 0x2A2018, roughness: 1.0 })
            );
            ash.position.y = 0.02;
            fireRing.add(ash);
            fireRing.position.set((Math.random() - 0.5) * 1.2, 0, (Math.random() - 0.5) * 1.2);
            group.add(fireRing);
        }
        return group;
    }

    /** アカシア（サバンナ樹）— 細長く曲がった幹に水平に広がる傘状の葉冠 */
    _buildAcaciaTree(group) {
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5A3E22, roughness: 0.95 });
        const segCount = 5;
        const lean = (Math.random() - 0.5) * 0.55;
        let prevY = 0;
        let prevX = 0;
        let prevZ = 0;
        const totalH = 5.5 + Math.random() * 2.0;
        for (let s = 0; s < segCount; s++) {
            const segH = totalH / segCount;
            const botR = 0.32 - s * 0.045;
            const topR = 0.32 - (s + 1) * 0.045;
            const seg = new THREE.Mesh(
                new THREE.CylinderGeometry(Math.max(topR, 0.08), Math.max(botR, 0.1), segH, 7),
                trunkMat
            );
            const tilt = (s === 0 ? 0 : (Math.random() - 0.5) * 0.18);
            seg.position.set(prevX + lean * 0.18, prevY + segH / 2, prevZ + tilt * 0.3);
            seg.rotation.z = lean * 0.08 - tilt;
            group.add(seg);
            prevY += segH;
            prevX += lean * 0.18;
            prevZ += tilt * 0.3;
        }

        // 枝分かれ（上部から左右にしなる枝）
        const branchMat = trunkMat;
        const branchTips = [];
        const branchCount = 4 + Math.floor(Math.random() * 3);
        for (let b = 0; b < branchCount; b++) {
            const a = (b / branchCount) * Math.PI * 2 + Math.random() * 0.6;
            const len = 1.6 + Math.random() * 0.9;
            const branch = new THREE.Mesh(
                new THREE.CylinderGeometry(0.06, 0.12, len, 5),
                branchMat
            );
            const tipX = prevX + Math.cos(a) * (len * 0.55);
            const tipY = prevY + 0.4 + Math.random() * 0.5;
            const tipZ = prevZ + Math.sin(a) * (len * 0.55);
            branch.position.set((prevX + tipX) / 2, (prevY + tipY) / 2, (prevZ + tipZ) / 2);
            const dir = new THREE.Vector3(tipX - prevX, tipY - prevY, tipZ - prevZ).normalize();
            const up = new THREE.Vector3(0, 1, 0);
            const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
            branch.quaternion.copy(q);
            group.add(branch);
            branchTips.push({ x: tipX, y: tipY, z: tipZ });
        }

        // 葉冠（傘状に水平に広がる、3層）
        const leafColors = [0x3D5A28, 0x4A6B30, 0x2F4A20, 0x5A7A38];
        const canopyR = 2.2 + Math.random() * 0.7;
        for (let layer = 0; layer < 3; layer++) {
            const ly = prevY + 0.3 + layer * 0.35;
            const lr = canopyR * (1 - layer * 0.18);
            const lh = 0.45 - layer * 0.08;
            const leafMat = new THREE.MeshStandardMaterial({
                color: leafColors[Math.floor(Math.random() * leafColors.length)],
                roughness: 0.9, flatShading: true,
            });
            // 葉冠は扁平な楕円体で表現
            const blob = new THREE.Mesh(
                new THREE.SphereGeometry(lr, 12, 8),
                leafMat
            );
            blob.scale.set(1, lh / lr, 1);
            blob.position.set(prevX + (Math.random() - 0.5) * 0.3, ly, prevZ + (Math.random() - 0.5) * 0.3);
            group.add(blob);
        }
        // 葉のシルエット小ブロブ（不揃いに）
        const accentMat = new THREE.MeshStandardMaterial({
            color: 0x4A6B30, roughness: 0.9, flatShading: true,
        });
        for (let i = 0; i < 8; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = canopyR * (0.5 + Math.random() * 0.5);
            const blob = new THREE.Mesh(
                new THREE.SphereGeometry(0.5 + Math.random() * 0.4, 8, 6),
                accentMat
            );
            blob.scale.y = 0.5;
            blob.position.set(
                prevX + Math.cos(a) * r,
                prevY + 0.2 + Math.random() * 0.6,
                prevZ + Math.sin(a) * r
            );
            group.add(blob);
        }
        return group;
    }

    /** 木製の足場/櫓（コンセプト画像左の構造物） */
    _buildWoodenScaffold(group) {
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x6A4422, roughness: 0.95 });
        const darkWoodMat = new THREE.MeshStandardMaterial({ color: 0x4A2E18, roughness: 0.95 });
        const w = 2.4 + Math.random() * 0.8;
        const d = 1.2 + Math.random() * 0.5;
        const h = 3.2 + Math.random() * 1.2;

        // 4本の柱
        const postR = 0.12;
        for (const px of [-w / 2, w / 2]) {
            for (const pz of [-d / 2, d / 2]) {
                const post = new THREE.Mesh(
                    new THREE.CylinderGeometry(postR, postR * 1.2, h, 6),
                    woodMat
                );
                post.position.set(px, h / 2, pz);
                post.castShadow = true;
                group.add(post);
            }
        }

        // 横木（水平の梁、複数段）
        const beamH = 0.12;
        const tiers = 3;
        for (let t = 0; t < tiers; t++) {
            const y = (t + 1) * (h / (tiers + 0.5));
            // X方向の梁（前後）
            for (const pz of [-d / 2, d / 2]) {
                const beam = new THREE.Mesh(
                    new THREE.BoxGeometry(w + 0.2, beamH, beamH),
                    darkWoodMat
                );
                beam.position.set(0, y, pz);
                group.add(beam);
            }
            // Z方向の梁（左右）
            for (const px of [-w / 2, w / 2]) {
                const beam = new THREE.Mesh(
                    new THREE.BoxGeometry(beamH, beamH, d + 0.2),
                    darkWoodMat
                );
                beam.position.set(px, y, 0);
                group.add(beam);
            }
        }

        // 上の床板（複数の板を並べる）
        const planks = 6;
        const plankMat = new THREE.MeshStandardMaterial({ color: 0x7A5A38, roughness: 0.95 });
        for (let i = 0; i < planks; i++) {
            const plank = new THREE.Mesh(
                new THREE.BoxGeometry(w + 0.1, 0.06, (d / planks) - 0.02),
                plankMat
            );
            plank.position.set(0, h, -d / 2 + (d / planks) * (i + 0.5));
            plank.rotation.y = (Math.random() - 0.5) * 0.02;
            group.add(plank);
        }

        // 斜めの筋交い（X字に交差）
        for (const side of [-1, 1]) {
            const len = Math.hypot(w, h);
            const brace = new THREE.Mesh(
                new THREE.BoxGeometry(0.08, len, 0.08),
                darkWoodMat
            );
            brace.position.set(0, h / 2, side * d / 2);
            brace.rotation.z = Math.atan2(w, h);
            brace.rotation.y = side > 0 ? 0 : Math.PI;
            group.add(brace);

            const brace2 = new THREE.Mesh(
                new THREE.BoxGeometry(0.08, len, 0.08),
                darkWoodMat
            );
            brace2.position.set(0, h / 2, side * d / 2);
            brace2.rotation.z = -Math.atan2(w, h);
            brace2.rotation.y = side > 0 ? 0 : Math.PI;
            group.add(brace2);
        }

        // 屋根（簡素な茅葺き or 帆布）
        if (Math.random() > 0.4) {
            const roofMat = new THREE.MeshStandardMaterial({
                color: 0xB89048, roughness: 1.0, flatShading: true,
            });
            const roof = new THREE.Mesh(
                new THREE.ConeGeometry(Math.max(w, d) * 0.85, 1.0, 4),
                roofMat
            );
            roof.position.y = h + 0.5;
            roof.rotation.y = Math.PI / 4;
            group.add(roof);
        }
        return group;
    }

    /** 土器/壺の集まり（村の生活感） */
    _buildClayPots(group) {
        const count = 2 + Math.floor(Math.random() * 4);
        const potColors = [0x8B4A20, 0x9C5028, 0xA85A30, 0x7A3E18, 0xB06038];
        for (let i = 0; i < count; i++) {
            const pot = new THREE.Group();
            const r = 0.18 + Math.random() * 0.18;
            const h = r * (1.6 + Math.random() * 0.7);
            const color = potColors[Math.floor(Math.random() * potColors.length)];
            const potMat = new THREE.MeshStandardMaterial({
                color, roughness: 0.85,
                emissive: new THREE.Color(color).multiplyScalar(0.04),
            });

            // 壺本体（ロウ・ジオメトリで膨らみのプロファイル）
            const points = [];
            const segs = 8;
            for (let p = 0; p <= segs; p++) {
                const t = p / segs;
                const y = t * h;
                let pr;
                if (t < 0.15) pr = r * (0.5 + t * 2.0);
                else if (t < 0.6) pr = r * (0.8 + Math.sin((t - 0.15) * Math.PI / 0.9) * 0.5);
                else pr = r * (0.85 - (t - 0.6) * 0.6);
                points.push(new THREE.Vector2(Math.max(pr, 0.04), y));
            }
            const body = new THREE.Mesh(
                new THREE.LatheGeometry(points, 12),
                potMat
            );
            body.castShadow = true;
            body.receiveShadow = true;
            pot.add(body);

            // 口縁の濃い帯
            const rim = new THREE.Mesh(
                new THREE.TorusGeometry(r * 0.55, 0.025, 4, 12),
                new THREE.MeshStandardMaterial({ color: 0x4A2410, roughness: 1.0 })
            );
            rim.rotation.x = Math.PI / 2;
            rim.position.y = h - 0.02;
            pot.add(rim);

            pot.position.set(
                (Math.random() - 0.5) * 1.2,
                0,
                (Math.random() - 0.5) * 1.0
            );
            pot.rotation.y = Math.random() * Math.PI * 2;
            group.add(pot);
        }

        // たまに転がった壺（横倒し）
        if (Math.random() > 0.6) {
            const fallen = new THREE.Mesh(
                new THREE.SphereGeometry(0.22, 10, 6),
                new THREE.MeshStandardMaterial({ color: 0x7A3818, roughness: 0.9 })
            );
            fallen.scale.set(1, 0.7, 1);
            fallen.rotation.z = Math.PI / 2;
            fallen.position.set((Math.random() - 0.5) * 1.0, 0.18, (Math.random() - 0.5) * 1.0);
            group.add(fallen);
        }
        return group;
    }

    /** 尖った木杭の柵（コンセプト画像下部の前景柵） */
    _buildSpikeFence(group) {
        const stakeMat = new THREE.MeshStandardMaterial({ color: 0x6A4422, roughness: 0.95 });
        const tipMat = new THREE.MeshStandardMaterial({ color: 0x3A2410, roughness: 0.95 });
        const stakeCount = 5 + Math.floor(Math.random() * 4);
        const spacing = 0.45;
        const totalW = (stakeCount - 1) * spacing;
        for (let i = 0; i < stakeCount; i++) {
            const x = -totalW / 2 + i * spacing + (Math.random() - 0.5) * 0.05;
            const h = 1.0 + Math.random() * 0.5;
            const tilt = (Math.random() - 0.5) * 0.12;

            const stake = new THREE.Mesh(
                new THREE.CylinderGeometry(0.07, 0.1, h, 6),
                stakeMat
            );
            stake.position.set(x, h / 2, (Math.random() - 0.5) * 0.15);
            stake.rotation.z = tilt;
            stake.castShadow = true;
            group.add(stake);

            // 尖端（焦げ茶のコーン）
            const tip = new THREE.Mesh(
                new THREE.ConeGeometry(0.08, 0.35, 6),
                tipMat
            );
            tip.position.set(stake.position.x + Math.sin(tilt) * h * 0.5, h + 0.13, stake.position.z);
            tip.rotation.z = tilt;
            group.add(tip);
        }

        // 横の縛り紐（蔓/縄）
        const ropeMat = new THREE.MeshStandardMaterial({ color: 0x4A3220, roughness: 1.0 });
        const rope = new THREE.Mesh(
            new THREE.CylinderGeometry(0.03, 0.03, totalW + 0.1, 4),
            ropeMat
        );
        rope.rotation.z = Math.PI / 2;
        rope.position.y = 0.7;
        group.add(rope);
        return group;
    }

    /** 村の井戸（石組みリングと木枠） */
    _buildVillageWell(group) {
        const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8A7256, roughness: 0.95, flatShading: true });

        // 石組みリング
        const ringR = 0.7;
        const ringH = 0.55;
        for (let i = 0; i < 14; i++) {
            const a = (i / 14) * Math.PI * 2;
            const stone = new THREE.Mesh(
                new THREE.BoxGeometry(0.32, ringH, 0.22),
                stoneMat
            );
            stone.position.set(Math.cos(a) * ringR, ringH / 2, Math.sin(a) * ringR);
            stone.rotation.y = -a;
            stone.position.y += (Math.random() - 0.5) * 0.04;
            group.add(stone);
        }

        // 内側の暗い水穴
        const hole = new THREE.Mesh(
            new THREE.CylinderGeometry(ringR - 0.18, ringR - 0.18, 0.12, 14),
            new THREE.MeshStandardMaterial({ color: 0x0A0A12, roughness: 1.0 })
        );
        hole.position.y = ringH - 0.04;
        group.add(hole);

        // A字フレーム（木枠）
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x4A2E18, roughness: 0.95 });
        const postH = 1.8;
        for (const side of [-1, 1]) {
            const post = new THREE.Mesh(
                new THREE.CylinderGeometry(0.08, 0.1, postH, 6),
                woodMat
            );
            post.position.set(side * 0.5, postH / 2, 0);
            post.rotation.z = -side * 0.18;
            group.add(post);
        }
        // 上の横木
        const cross = new THREE.Mesh(
            new THREE.CylinderGeometry(0.07, 0.07, 1.4, 6),
            woodMat
        );
        cross.rotation.z = Math.PI / 2;
        cross.position.y = postH - 0.1;
        group.add(cross);

        // 吊り下げバケツ
        const bucket = new THREE.Mesh(
            new THREE.CylinderGeometry(0.13, 0.16, 0.25, 8),
            new THREE.MeshStandardMaterial({ color: 0x6A4220, roughness: 0.85 })
        );
        bucket.position.set(0, postH - 0.6, 0);
        group.add(bucket);
        // ロープ
        const ropeMat = new THREE.MeshStandardMaterial({ color: 0xA08858, roughness: 1.0 });
        const rope = new THREE.Mesh(
            new THREE.CylinderGeometry(0.015, 0.015, 0.5, 4),
            ropeMat
        );
        rope.position.set(0, postH - 0.35, 0);
        group.add(rope);

        return group;
    }

    /* ========================================================
     *  LATE-STAGE PALACE - コンセプト画像 m3jxBpfv0qrr.jpg 準拠
     *  銅赤のリブ付きオニオンドーム宮殿、城壁、果物屋台
     * ======================================================== */

    /** 縦リブ（瓜模様）付きの大ドーム（玉ねぎ形） */
    _buildRibbedOnionDome(baseR, totalH, color, ribCount = 12) {
        const group = new THREE.Group();
        const segments = 22;

        // ベースドーム本体（少し暗めの陰影色）
        const points = [];
        points.push(new THREE.Vector2(baseR * 0.55, 0));
        points.push(new THREE.Vector2(baseR * 0.85, totalH * 0.05));
        points.push(new THREE.Vector2(baseR * 1.10, totalH * 0.18));
        points.push(new THREE.Vector2(baseR * 1.18, totalH * 0.32));
        points.push(new THREE.Vector2(baseR * 1.10, totalH * 0.48));
        points.push(new THREE.Vector2(baseR * 0.92, totalH * 0.62));
        points.push(new THREE.Vector2(baseR * 0.70, totalH * 0.75));
        points.push(new THREE.Vector2(baseR * 0.42, totalH * 0.86));
        points.push(new THREE.Vector2(baseR * 0.18, totalH * 0.95));
        points.push(new THREE.Vector2(baseR * 0.04, totalH));
        const baseColor = new THREE.Color(color).multiplyScalar(0.78);
        const baseMat = new THREE.MeshStandardMaterial({
            color: baseColor, roughness: 0.7, metalness: 0.35,
        });
        const baseDome = new THREE.Mesh(
            new THREE.LatheGeometry(points, segments),
            baseMat
        );
        baseDome.castShadow = true;
        group.add(baseDome);

        // リブ（外側の凸条 — 細長い扁平トーラスを並べて見せる）
        const ribMat = new THREE.MeshStandardMaterial({
            color, roughness: 0.55, metalness: 0.55,
        });
        for (let r = 0; r < ribCount; r++) {
            const angle = (r / ribCount) * Math.PI * 2;
            // リブを Lathe で半周分作り、Y軸回転させて配置
            const ribPoints = [];
            const ribSegs = 14;
            for (let p = 0; p <= ribSegs; p++) {
                const t = p / ribSegs;
                const py = totalH * t;
                const profile = points[Math.min(Math.floor(t * (points.length - 1)), points.length - 2)];
                const next = points[Math.min(Math.floor(t * (points.length - 1)) + 1, points.length - 1)];
                const lt = (t * (points.length - 1)) % 1;
                const px = profile.x + (next.x - profile.x) * lt;
                ribPoints.push(new THREE.Vector2(px * 1.06 + 0.02, py));
            }
            const ribGeo = new THREE.LatheGeometry(ribPoints, 4, angle - 0.08, 0.16);
            const rib = new THREE.Mesh(ribGeo, ribMat);
            group.add(rib);
        }

        // 頂点フィニアル（黄金の球＋スパイク）
        const finialMat = new THREE.MeshStandardMaterial({
            color: 0xD4A030, roughness: 0.4, metalness: 0.85,
            emissive: 0x3a2a08, emissiveIntensity: 0.18,
        });
        const finialBall = new THREE.Mesh(
            new THREE.SphereGeometry(baseR * 0.12, 12, 8),
            finialMat
        );
        finialBall.position.y = totalH + baseR * 0.1;
        group.add(finialBall);
        const finialSpike = new THREE.Mesh(
            new THREE.ConeGeometry(baseR * 0.04, baseR * 0.4, 8),
            finialMat
        );
        finialSpike.position.y = totalH + baseR * 0.35;
        group.add(finialSpike);
        // 三日月
        const crescent = new THREE.Mesh(
            new THREE.TorusGeometry(baseR * 0.09, baseR * 0.018, 4, 10, Math.PI * 1.2),
            finialMat
        );
        crescent.position.y = totalH + baseR * 0.6;
        crescent.rotation.x = Math.PI / 2;
        group.add(crescent);

        // ドーム基部のリング（金の帯）
        const ringMat = new THREE.MeshStandardMaterial({
            color: 0xCFA050, roughness: 0.5, metalness: 0.7,
        });
        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(baseR * 0.6, 0.08, 6, 18),
            ringMat
        );
        ring.position.y = -0.04;
        ring.rotation.x = Math.PI / 2;
        group.add(ring);

        return group;
    }

    /** 銅赤の宮殿（リブ付きオニオンドーム複数＋アドベ壁＋アーチ＋書法バナー） */
    _buildCopperPalace(group) {
        // 基壇（クリーム色のアドベ／砂岩壁）
        const wallMat = new THREE.MeshStandardMaterial({
            color: 0xD8B888, roughness: 0.95,
        });
        const wallW = 7.5;
        const wallD = 4.0;
        const wallH = 3.6;
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(wallW, wallH, wallD),
            wallMat
        );
        base.position.y = wallH / 2;
        base.castShadow = true;
        base.receiveShadow = true;
        group.add(base);

        // 壁の風化縞（横帯）
        const stripeMat = new THREE.MeshStandardMaterial({ color: 0xB89060, roughness: 1.0 });
        for (let s = 0; s < 4; s++) {
            const stripe = new THREE.Mesh(
                new THREE.BoxGeometry(wallW + 0.05, 0.06, wallD + 0.05),
                stripeMat
            );
            stripe.position.y = 0.6 + s * 0.85;
            group.add(stripe);
        }

        // 中央の尖頭アーチ（暗い入り口）
        const arch = this._buildPointedArch(2.0, 3.0, 0.18, 0x1A0F08);
        arch.position.set(0, 0, wallD / 2 + 0.05);
        group.add(arch);

        // アーチ上の書法バナー（青地に金文字）
        const banner = this._buildCalligraphyBanner(3.4, 0.7, 3.1, wallD / 2 + 0.18);
        group.add(banner);

        // 装飾ジグザグ・コーニス（壁の上端）
        const corniceMat = new THREE.MeshStandardMaterial({ color: 0x7A4A28, roughness: 0.85 });
        const corniceCount = 14;
        for (let i = 0; i < corniceCount; i++) {
            const triangle = new THREE.Mesh(
                new THREE.ConeGeometry(0.18, 0.32, 4),
                corniceMat
            );
            triangle.position.set(
                -wallW / 2 + 0.4 + i * (wallW - 0.8) / (corniceCount - 1),
                wallH + 0.16,
                wallD / 2 + 0.05
            );
            triangle.rotation.y = Math.PI / 4;
            group.add(triangle);
        }

        // ドーム基壇（壁上の各ドーム下のドラム）
        const drumMat = new THREE.MeshStandardMaterial({ color: 0xC8A07C, roughness: 0.9 });
        const domeColors = [0x8C2818, 0xA0381C, 0x701A0C];
        const domeXs = [-2.4, 0.4, 2.6];
        const domeRadii = [1.05, 1.35, 1.0];
        const domeHeights = [3.2, 4.0, 3.0];
        for (let i = 0; i < domeXs.length; i++) {
            const dx = domeXs[i];
            const baseR = domeRadii[i];
            const dh = domeHeights[i];
            const drum = new THREE.Mesh(
                new THREE.CylinderGeometry(baseR * 0.95, baseR * 1.0, 0.6, 16),
                drumMat
            );
            drum.position.set(dx, wallH + 0.3, 0);
            group.add(drum);

            // 小さな尖頭窓（ドラム周り）
            for (let w = 0; w < 4; w++) {
                const wa = w * Math.PI / 2 + Math.PI / 4;
                const win = this._buildPointedArch(0.28, 0.5, 0.05, 0x1A0F1F);
                win.position.set(
                    dx + Math.cos(wa) * baseR * 0.96,
                    wallH + 0.55,
                    Math.sin(wa) * baseR * 0.96
                );
                win.rotation.y = wa - Math.PI / 2;
                group.add(win);
            }

            const dome = this._buildRibbedOnionDome(baseR, dh, domeColors[i % domeColors.length], 12);
            dome.position.set(dx, wallH + 0.65, 0);
            group.add(dome);
        }

        // 入り口横の縞ひさし
        const awning = this._buildStripedAwning(2.6, 1.4, 0xCB3E1A, 0xF0D260, 8);
        awning.position.set(0, 2.7, wallD / 2 + 0.15);
        group.add(awning);

        // 側壁の小窓（尖頭）
        for (let i = -1; i <= 1; i += 2) {
            for (let y of [1.2, 2.4]) {
                const win = this._buildPointedArch(0.5, 0.95, 0.08, 0x1A0F1F);
                win.position.set(i * (wallW / 2 - 1.2), y, wallD / 2 + 0.05);
                group.add(win);
            }
        }

        return group;
    }

    /** 城壁（クレネーション付き、コンセプト画像右の高い壁） */
    _buildFortressWall(group) {
        const stoneColors = [0xC8A878, 0xB8986A, 0xA88858, 0xD4B080];
        const blockMat = new THREE.MeshStandardMaterial({
            color: stoneColors[Math.floor(Math.random() * stoneColors.length)],
            roughness: 0.95, flatShading: true,
        });
        const wallW = 5.0;
        const wallH = 5.5;
        const wallD = 1.2;

        // 本体壁
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(wallW, wallH, wallD),
            blockMat
        );
        body.position.y = wallH / 2;
        body.castShadow = true;
        body.receiveShadow = true;
        group.add(body);

        // 石ブロックの目地（横方向の薄い溝）
        const grooveMat = new THREE.MeshStandardMaterial({ color: 0x8A6A40, roughness: 1.0 });
        for (let h = 0; h < 8; h++) {
            const groove = new THREE.Mesh(
                new THREE.BoxGeometry(wallW + 0.02, 0.04, wallD + 0.02),
                grooveMat
            );
            groove.position.y = 0.7 + h * 0.65;
            group.add(groove);
        }
        // 縦の目地（ブロックずらし）
        for (let h = 0; h < 8; h++) {
            const offset = (h % 2) * 0.45;
            for (let x = -wallW / 2 + 0.45 + offset; x < wallW / 2; x += 0.9) {
                const vGroove = new THREE.Mesh(
                    new THREE.BoxGeometry(0.04, 0.65, wallD + 0.02),
                    grooveMat
                );
                vGroove.position.set(x, 0.7 + h * 0.65 + 0.3, 0);
                group.add(vGroove);
            }
        }

        // クレネーション（メルロン — 上の歯型）
        const merlonW = 0.5;
        const merlonH = 0.7;
        const merlonGap = 0.35;
        const merlonStep = merlonW + merlonGap;
        const merlonCount = Math.floor(wallW / merlonStep);
        const merlonStart = -((merlonCount - 1) * merlonStep) / 2;
        for (let i = 0; i < merlonCount; i++) {
            const merlon = new THREE.Mesh(
                new THREE.BoxGeometry(merlonW, merlonH, wallD),
                blockMat
            );
            merlon.position.set(merlonStart + i * merlonStep, wallH + merlonH / 2, 0);
            group.add(merlon);
        }

        // 上端の縁取り
        const cap = new THREE.Mesh(
            new THREE.BoxGeometry(wallW + 0.15, 0.18, wallD + 0.15),
            new THREE.MeshStandardMaterial({ color: 0x8A6A48, roughness: 0.9 })
        );
        cap.position.y = wallH + 0.09;
        group.add(cap);

        // 矢狭間（小さな縦長の暗い窓）
        for (let i = -1; i <= 1; i++) {
            const slit = new THREE.Mesh(
                new THREE.BoxGeometry(0.12, 0.7, 0.05),
                new THREE.MeshStandardMaterial({ color: 0x0A0805, roughness: 1.0 })
            );
            slit.position.set(i * 1.4, wallH * 0.65, wallD / 2 + 0.03);
            group.add(slit);
        }

        // 下部の苔／泥染み
        const stainMat = new THREE.MeshStandardMaterial({ color: 0x6A5230, roughness: 1.0, transparent: true, opacity: 0.6 });
        for (let i = 0; i < 3; i++) {
            const stain = new THREE.Mesh(
                new THREE.PlaneGeometry(1.2, 0.8),
                stainMat
            );
            stain.position.set(-wallW / 2 + 1 + i * 1.6, 0.6, wallD / 2 + 0.04);
            group.add(stain);
        }

        return group;
    }

    /** 果物屋台（垂直の支柱に吊るしたバスケット＋オレンジの山） */
    _buildFruitStand(group) {
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x6A4422, roughness: 0.95 });
        // 支柱
        const pole = new THREE.Mesh(
            new THREE.CylinderGeometry(0.06, 0.07, 3.2, 6),
            woodMat
        );
        pole.position.y = 1.6;
        group.add(pole);

        // 上の横木
        const cross = new THREE.Mesh(
            new THREE.CylinderGeometry(0.045, 0.045, 1.3, 6),
            woodMat
        );
        cross.rotation.z = Math.PI / 2;
        cross.position.y = 3.0;
        group.add(cross);

        // バスケット2個（吊り下げ）
        const basketMat = new THREE.MeshStandardMaterial({ color: 0x7A5A30, roughness: 1.0 });
        const orangeMat = new THREE.MeshStandardMaterial({
            color: 0xE87838, roughness: 0.7,
            emissive: 0x3a1a08, emissiveIntensity: 0.12,
        });
        for (const xOff of [-0.5, 0.5]) {
            const basket = new THREE.Mesh(
                new THREE.CylinderGeometry(0.28, 0.22, 0.25, 10, 1, true),
                basketMat
            );
            basket.position.set(xOff, 2.55, 0);
            group.add(basket);

            // ロープ
            const ropeMat = new THREE.MeshStandardMaterial({ color: 0xA08858, roughness: 1.0 });
            const rope = new THREE.Mesh(
                new THREE.CylinderGeometry(0.012, 0.012, 0.4, 4),
                ropeMat
            );
            rope.position.set(xOff, 2.85, 0);
            group.add(rope);

            // バスケット内のオレンジ
            for (let o = 0; o < 7; o++) {
                const orange = new THREE.Mesh(
                    new THREE.SphereGeometry(0.08, 6, 5),
                    orangeMat
                );
                orange.position.set(
                    xOff + (Math.random() - 0.5) * 0.35,
                    2.65 + Math.random() * 0.08,
                    (Math.random() - 0.5) * 0.35
                );
                group.add(orange);
            }
        }

        // 地面の木箱台
        const crateMat = new THREE.MeshStandardMaterial({ color: 0x7A5A38, roughness: 0.95 });
        const crate = new THREE.Mesh(
            new THREE.BoxGeometry(1.4, 0.5, 0.9),
            crateMat
        );
        crate.position.y = 0.25;
        group.add(crate);

        // 木箱の上に積まれたオレンジの山
        for (let o = 0; o < 14; o++) {
            const orange = new THREE.Mesh(
                new THREE.SphereGeometry(0.09, 6, 5),
                orangeMat
            );
            const layer = Math.floor(o / 7);
            orange.position.set(
                (Math.random() - 0.5) * 1.0,
                0.55 + layer * 0.13 + Math.random() * 0.04,
                (Math.random() - 0.5) * 0.5
            );
            group.add(orange);
        }

        // 横木の端から垂れる旗（赤＋クリームの縞）
        const flagMat = new THREE.MeshStandardMaterial({
            color: 0xCB3E1A, roughness: 0.9, side: THREE.DoubleSide,
        });
        const flag = new THREE.Mesh(
            new THREE.PlaneGeometry(0.5, 0.7),
            flagMat
        );
        flag.position.set(0.5, 2.7, 0.05);
        group.add(flag);

        return group;
    }

    /* ========================================================
     *  ROADSIDE SHOPS - 雑貨屋 / 八百屋（破壊可・幹線道路脇）
     *  幹線道路に面した木造店舗。砲弾を複数発当てると爆発し倒壊する。
     *  ローカル +Z = 店先（道路側）、ローカル -Z = 店奥。
     * ======================================================== */

    /** 雑貨屋（木造・瓦屋根・暖簾・吊提灯・棚に瓶/缶/木箱） */
    _buildGeneralStore(group) {
        const W = 5.0, H = 3.2, D = 2.8;
        const woodDark  = _sharedMat('shop_wood_dark',  () => new THREE.MeshStandardMaterial({ color: 0x3A2410, roughness: 0.95 }));
        const woodMid   = _sharedMat('shop_wood_mid',   () => new THREE.MeshStandardMaterial({ color: 0x6A4A28, roughness: 0.92 }));
        const woodLight = _sharedMat('shop_wood_light', () => new THREE.MeshStandardMaterial({ color: 0x8E6638, roughness: 0.9 }));
        const wallMat   = _sharedMat('shop_plaster',    () => new THREE.MeshStandardMaterial({ color: 0xD8C8A0, roughness: 0.98 }));
        const wallShade = _sharedMat('shop_plaster_sh', () => new THREE.MeshStandardMaterial({ color: 0xB8A480, roughness: 0.98 }));
        const tileMat   = _sharedMat('shop_roof_tile',  () => new THREE.MeshStandardMaterial({ color: 0x4A3828, roughness: 0.9 }));
        const tileEdge  = _sharedMat('shop_roof_edge',  () => new THREE.MeshStandardMaterial({ color: 0x2A1A0E, roughness: 0.9 }));
        const norenMat  = _sharedMat('shop_noren',      () => new THREE.MeshStandardMaterial({ color: 0x1F3C66, roughness: 0.95, side: THREE.DoubleSide }));
        const signWood  = _sharedMat('shop_sign_wood',  () => new THREE.MeshStandardMaterial({ color: 0xE8D098, roughness: 0.92 }));
        const inkMat    = _sharedMat('shop_ink',        () => new THREE.MeshStandardMaterial({ color: 0x1A0F08, roughness: 0.95 }));
        const lanternMat= _sharedMat('shop_lantern',    () => new THREE.MeshStandardMaterial({ color: 0xE85A30, emissive: 0x6A1A08, emissiveIntensity: 0.35, roughness: 0.85 }));
        const whitePaint= _sharedMat('shop_white',      () => new THREE.MeshStandardMaterial({ color: 0xF0E6D0, roughness: 0.9 }));
        const tatamiMat = _sharedMat('shop_tatami',     () => new THREE.MeshStandardMaterial({ color: 0xC8A868, roughness: 0.95 }));

        // 本体（店奥の漆喰壁）
        const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D - 0.4), wallMat);
        body.position.set(0, H / 2, -D / 2 + 0.2);
        body.castShadow = true;
        body.receiveShadow = true;
        group.add(body);
        // 漆喰の腰板（暗色）
        const wainscot = new THREE.Mesh(new THREE.BoxGeometry(W + 0.02, 0.7, D - 0.35), wallShade);
        wainscot.position.set(0, 0.35, -D / 2 + 0.2);
        group.add(wainscot);

        // 黒柱4本（前後の四隅）
        for (const sx of [-1, 1]) {
            for (const sz of [0.55, -D + 0.45]) {
                const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, H + 0.1, 0.22), woodDark);
                post.position.set(sx * (W / 2), H / 2, sz);
                post.castShadow = true;
                group.add(post);
            }
        }
        // 中柱（前面中央寄り、2本）
        for (const sx of [-1, 1]) {
            const midPost = new THREE.Mesh(new THREE.BoxGeometry(0.16, H, 0.16), woodDark);
            midPost.position.set(sx * (W / 6), H / 2, 0.55);
            group.add(midPost);
        }
        // 前面の上の梁（横）
        const topBeam = new THREE.Mesh(new THREE.BoxGeometry(W + 0.36, 0.26, 0.24), woodDark);
        topBeam.position.set(0, H + 0.02, 0.55);
        group.add(topBeam);
        // 中段の桟
        const midRail = new THREE.Mesh(new THREE.BoxGeometry(W + 0.1, 0.1, 0.12), woodDark);
        midRail.position.set(0, H - 0.5, 0.55);
        group.add(midRail);

        // 瓦屋根（前傾、深い軒）
        const eaveOver = 0.95;
        const roof = new THREE.Mesh(new THREE.BoxGeometry(W + 0.7, 0.16, D + eaveOver + 0.3), tileMat);
        roof.position.set(0, H + 0.34, -D / 2 + 0.4 + eaveOver / 2);
        roof.rotation.x = -0.06;
        roof.castShadow = true;
        group.add(roof);
        // 瓦の段差（横列）
        const tileRows = 7;
        for (let i = 0; i < tileRows; i++) {
            const t = i / (tileRows - 1);
            const ridge = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, 0.05, 0.18), tileEdge);
            const zRow = -D / 2 + 0.45 + t * (D + eaveOver - 0.1);
            ridge.position.set(0, H + 0.4 + (1 - t) * 0.04, zRow);
            ridge.rotation.x = -0.06;
            group.add(ridge);
        }
        // 棟瓦（屋根頂）
        const ridgeCap = new THREE.Mesh(new THREE.BoxGeometry(W + 0.5, 0.2, 0.42), tileEdge);
        ridgeCap.position.set(0, H + 0.5, -D / 2 + 0.45);
        group.add(ridgeCap);
        // 鬼瓦風の両端突起
        for (const sx of [-1, 1]) {
            const oni = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.32, 4), tileEdge);
            oni.position.set(sx * (W / 2 + 0.2), H + 0.7, -D / 2 + 0.45);
            oni.rotation.y = Math.PI / 4;
            group.add(oni);
        }

        // 縁台（店先の小上がり）
        const counter = new THREE.Mesh(new THREE.BoxGeometry(W - 0.5, 0.7, 1.1), woodMid);
        counter.position.set(0, 0.35, 0.75);
        counter.castShadow = true;
        counter.receiveShadow = true;
        group.add(counter);
        const counterTop = new THREE.Mesh(new THREE.BoxGeometry(W - 0.35, 0.06, 1.15), woodLight);
        counterTop.position.set(0, 0.73, 0.75);
        group.add(counterTop);
        // 縁台の脚（前2本）
        for (const sx of [-1, 1]) {
            const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.7, 0.1), woodDark);
            leg.position.set(sx * (W / 2 - 0.45), 0.35, 1.22);
            group.add(leg);
        }

        // 暖簾（4分割の藍色の幕）
        const norenCount = 4;
        for (let i = 0; i < norenCount; i++) {
            const nx = -W / 2 + 0.55 + i * ((W - 1.1) / (norenCount - 1));
            const noren = new THREE.Mesh(new THREE.PlaneGeometry((W - 1.1) / norenCount - 0.05, 1.05), norenMat);
            noren.position.set(nx, H - 0.6, 0.74);
            group.add(noren);
        }
        // 暖簾中央に白い屋号印
        for (let i = 0; i < 3; i++) {
            const ch = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.13), whitePaint);
            ch.position.set(0, H - 0.35 - i * 0.2, 0.745);
            group.add(ch);
        }
        // 暖簾を吊る竹竿
        const norenRod = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, W - 0.2, 6), woodLight);
        norenRod.rotation.z = Math.PI / 2;
        norenRod.position.set(0, H - 0.1, 0.73);
        group.add(norenRod);

        // 看板（縦長、軒下右側に吊り下げ）
        const signBoard = new THREE.Mesh(new THREE.BoxGeometry(0.72, 1.7, 0.1), signWood);
        signBoard.position.set(W / 2 - 0.55, H - 0.35, 1.15);
        signBoard.castShadow = true;
        group.add(signBoard);
        const signFrame = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.78, 0.06), woodDark);
        signFrame.position.set(W / 2 - 0.55, H - 0.35, 1.12);
        group.add(signFrame);
        // 看板の毛筆文字（縦に3文字、簡易シルエット）
        for (let i = 0; i < 3; i++) {
            const cy = H + 0.15 - i * 0.48;
            const v = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.24, 0.02), inkMat);
            v.position.set(W / 2 - 0.55, cy, 1.21);
            group.add(v);
            const h = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.06, 0.02), inkMat);
            h.position.set(W / 2 - 0.55, cy + 0.02, 1.21);
            group.add(h);
            const h2 = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 0.02), inkMat);
            h2.position.set(W / 2 - 0.55, cy - 0.1, 1.21);
            group.add(h2);
        }
        // 看板を吊る紐（2本）
        for (const sx of [-0.22, 0.22]) {
            const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.32, 4), woodDark);
            rope.position.set(W / 2 - 0.55 + sx, H + 0.6, 1.15);
            group.add(rope);
        }

        // 提灯（軒下に2つ）
        for (const xOff of [-W / 2 + 0.55, W / 2 - 0.55]) {
            const lan = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), lanternMat);
            lan.position.set(xOff, H - 0.15, 0.95);
            lan.scale.set(1, 0.85, 1);
            group.add(lan);
            for (const yOff of [-0.18, 0.18]) {
                const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.022, 4, 14), woodDark);
                stripe.rotation.x = Math.PI / 2;
                stripe.position.set(xOff, H - 0.15 + yOff, 0.95);
                group.add(stripe);
            }
            const lanRope = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 4), woodDark);
            lanRope.position.set(xOff, H + 0.13, 0.95);
            group.add(lanRope);
        }

        // 店内の畳（床）
        const tatami = new THREE.Mesh(new THREE.BoxGeometry(W - 0.5, 0.05, D - 0.8), tatamiMat);
        tatami.position.set(0, 0.78, -D / 2 + 0.3);
        group.add(tatami);

        // 棚（奥の壁に3段、商品が並ぶ）
        const itemColors = [0x3a6648, 0x6a3a2a, 0x4a4a78, 0x8a6a30, 0xc44830, 0xd8a838, 0x4a8a68, 0xc8c8c8];
        for (let s = 0; s < 3; s++) {
            const shelfY = 0.95 + s * 0.62;
            const shelf = new THREE.Mesh(new THREE.BoxGeometry(W - 1.2, 0.06, 0.45), woodMid);
            shelf.position.set(0, shelfY, -D + 0.55);
            group.add(shelf);
            const shelfEdge = new THREE.Mesh(new THREE.BoxGeometry(W - 1.15, 0.04, 0.05), woodDark);
            shelfEdge.position.set(0, shelfY - 0.02, -D + 0.78);
            group.add(shelfEdge);
            // 棚上の商品（7点）
            const itemCount = 7;
            for (let i = 0; i < itemCount; i++) {
                const ix = -W / 2 + 0.85 + i * ((W - 1.7) / (itemCount - 1));
                const r = Math.random();
                if (r < 0.4) {
                    // 瓶
                    const c = itemColors[Math.floor(Math.random() * 4)];
                    const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.4 });
                    const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.4, 8), m);
                    bottle.position.set(ix, shelfY + 0.23, -D + 0.6);
                    group.add(bottle);
                    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.12, 6), m);
                    neck.position.set(ix, shelfY + 0.49, -D + 0.6);
                    group.add(neck);
                } else if (r < 0.75) {
                    // 缶
                    const c = itemColors[4 + Math.floor(Math.random() * 4)];
                    const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.4 });
                    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.32, 10), m);
                    can.position.set(ix, shelfY + 0.19, -D + 0.6);
                    group.add(can);
                    const label = new THREE.Mesh(new THREE.CylinderGeometry(0.086, 0.086, 0.1, 10), whitePaint);
                    label.position.set(ix, shelfY + 0.19, -D + 0.6);
                    group.add(label);
                } else {
                    // 小箱
                    const c = 0x9A6A38 + Math.floor(Math.random() * 0x202020);
                    const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 });
                    const box = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.24, 0.18), m);
                    box.position.set(ix, shelfY + 0.15, -D + 0.6);
                    box.rotation.y = (Math.random() - 0.5) * 0.4;
                    group.add(box);
                }
            }
        }

        // 縁台の上の商品（手前）
        for (let i = 0; i < 3; i++) {
            const cx = -W / 2 + 1.0 + i * ((W - 2.0) / 2);
            if (i === 1) {
                // 中央: 大きな壺
                const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.42, 12), woodLight);
                pot.position.set(cx, 0.97, 0.65);
                group.add(pot);
                const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.06, 12), woodDark);
                lid.position.set(cx, 1.21, 0.65);
                group.add(lid);
            } else {
                const box = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.32, 0.6), woodMid);
                box.position.set(cx, 0.92, 0.65);
                box.rotation.y = (Math.random() - 0.5) * 0.2;
                group.add(box);
                // フタの板
                const top = new THREE.Mesh(new THREE.BoxGeometry(0.47, 0.04, 0.62), woodDark);
                top.position.set(cx, 1.1, 0.65);
                top.rotation.y = box.rotation.y;
                group.add(top);
            }
        }

        // 店先の桶（地面、右側）
        const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.26, 0.42, 12), woodDark);
        bucket.position.set(W / 2 - 0.4, 0.21, 1.35);
        group.add(bucket);
        const water = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.02, 12), new THREE.MeshStandardMaterial({ color: 0x1a2a3a, roughness: 0.3 }));
        water.position.set(W / 2 - 0.4, 0.41, 1.35);
        group.add(water);
        // 桶のたが
        for (const yOff of [-0.13, 0.13]) {
            const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.018, 4, 16), woodLight);
            hoop.rotation.x = Math.PI / 2;
            hoop.position.set(W / 2 - 0.4, 0.21 + yOff, 1.35);
            group.add(hoop);
        }

        // 箒（縁台に立てかける）
        const broomStick = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.5, 6), woodLight);
        broomStick.position.set(W / 2 - 0.15, 0.85, 1.25);
        broomStick.rotation.z = -0.22;
        group.add(broomStick);
        const broomHead = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.32, 8), woodMid);
        broomHead.position.set(W / 2 - 0.47, 0.18, 1.25);
        broomHead.rotation.z = -0.22;
        group.add(broomHead);

        // 立て看板（道路側、地面）
        const standSign = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.06), signWood);
        standSign.position.set(-W / 2 + 0.4, 0.6, 1.35);
        standSign.rotation.y = -0.2;
        group.add(standSign);
        const standFrame = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.75, 0.03), woodDark);
        standFrame.position.set(-W / 2 + 0.4, 0.6, 1.32);
        standFrame.rotation.y = -0.2;
        group.add(standFrame);
        // 立て看板の脚
        for (const sx of [-0.18, 0.18]) {
            const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.05), woodDark);
            leg.position.set(-W / 2 + 0.4 + Math.cos(-0.2) * sx, 0.25, 1.35 - Math.sin(-0.2) * sx);
            leg.rotation.y = -0.2;
            group.add(leg);
        }
        // 立て看板の文字（横線3本）
        for (let i = 0; i < 3; i++) {
            const ln = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.05, 0.02), inkMat);
            ln.position.set(-W / 2 + 0.4 + Math.cos(-0.2) * 0.04, 0.78 - i * 0.15, 1.35 - Math.sin(-0.2) * 0.04);
            ln.rotation.y = -0.2;
            group.add(ln);
        }

        return group;
    }

    /** 八百屋（赤白縞オーニング・スロープ陳列台・吊り野菜・黒板看板） */
    _buildVegetableShop(group) {
        const W = 5.0, H = 2.9, D = 2.6;
        const woodDark  = _sharedMat('shop_wood_dark',  () => new THREE.MeshStandardMaterial({ color: 0x3A2410, roughness: 0.95 }));
        const woodMid   = _sharedMat('shop_wood_mid',   () => new THREE.MeshStandardMaterial({ color: 0x6A4A28, roughness: 0.92 }));
        const woodLight = _sharedMat('shop_wood_light', () => new THREE.MeshStandardMaterial({ color: 0x8E6638, roughness: 0.9 }));
        const wallMat   = _sharedMat('vshop_wall',      () => new THREE.MeshStandardMaterial({ color: 0xE6D2A6, roughness: 0.98 }));
        const wallShade = _sharedMat('vshop_wall_sh',   () => new THREE.MeshStandardMaterial({ color: 0xC4B088, roughness: 0.98 }));
        const stripeR   = _sharedMat('vshop_stripe_r',  () => new THREE.MeshStandardMaterial({ color: 0xC04030, roughness: 0.85, side: THREE.DoubleSide }));
        const stripeW   = _sharedMat('vshop_stripe_w',  () => new THREE.MeshStandardMaterial({ color: 0xEEDFC2, roughness: 0.9, side: THREE.DoubleSide }));
        const chalkboard= _sharedMat('vshop_chalk',     () => new THREE.MeshStandardMaterial({ color: 0x1f2a1a, roughness: 0.95 }));
        const chalk     = _sharedMat('vshop_chalk_m',   () => new THREE.MeshStandardMaterial({ color: 0xF0E8C8, roughness: 0.95 }));
        const greenSign = _sharedMat('vshop_green',     () => new THREE.MeshStandardMaterial({ color: 0x3A7838, roughness: 0.9 }));
        const yellowSign= _sharedMat('vshop_yellow',    () => new THREE.MeshStandardMaterial({ color: 0xE8C040, roughness: 0.9 }));
        const wicker    = _sharedMat('vshop_wicker',    () => new THREE.MeshStandardMaterial({ color: 0xB58A4A, roughness: 1.0 }));
        const inkMat    = _sharedMat('shop_ink',        () => new THREE.MeshStandardMaterial({ color: 0x1A0F08, roughness: 0.95 }));

        // 後ろの漆喰壁
        const back = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.3), wallMat);
        back.position.set(0, H / 2, -D + 0.15);
        back.castShadow = true;
        group.add(back);
        // 腰板
        const skirt = new THREE.Mesh(new THREE.BoxGeometry(W + 0.02, 0.6, 0.32), wallShade);
        skirt.position.set(0, 0.3, -D + 0.15);
        group.add(skirt);
        // 側壁（半分の高さ）
        for (const sx of [-1, 1]) {
            const side = new THREE.Mesh(new THREE.BoxGeometry(0.18, H * 0.6, D - 0.4), wallShade);
            side.position.set(sx * W / 2, H * 0.3, -D / 2 + 0.1);
            group.add(side);
        }

        // 屋根（フラット）
        const roof = new THREE.Mesh(new THREE.BoxGeometry(W + 0.4, 0.18, D + 0.1), woodMid);
        roof.position.set(0, H + 0.09, -D / 2 + 0.15);
        roof.castShadow = true;
        group.add(roof);
        const roofEdge = new THREE.Mesh(new THREE.BoxGeometry(W + 0.5, 0.06, D + 0.18), woodDark);
        roofEdge.position.set(0, H + 0.21, -D / 2 + 0.15);
        group.add(roofEdge);

        // 前面の柱
        for (const sx of [-1, 1]) {
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, H + 0.15, 0.18), woodDark);
            post.position.set(sx * W / 2, H / 2, 0.5);
            post.castShadow = true;
            group.add(post);
        }
        // 上の梁
        const topBeam = new THREE.Mesh(new THREE.BoxGeometry(W + 0.4, 0.22, 0.22), woodDark);
        topBeam.position.set(0, H, 0.5);
        group.add(topBeam);

        // === 赤白縞オーニング（前傾） ===
        const awnW = W + 0.5, awnD = 1.7;
        const stripeCount = 8;
        const stripeWidth = awnW / stripeCount;
        const awnGroup = new THREE.Group();
        for (let i = 0; i < stripeCount; i++) {
            const isRed = i % 2 === 0;
            const stripe = new THREE.Mesh(
                new THREE.BoxGeometry(stripeWidth - 0.02, 0.04, awnD),
                isRed ? stripeR : stripeW
            );
            stripe.position.set(-awnW / 2 + (i + 0.5) * stripeWidth, 0, 0);
            stripe.castShadow = true;
            awnGroup.add(stripe);
        }
        // 縞オーニングの裏地（一枚板で受ける）
        const awnBack = new THREE.Mesh(new THREE.BoxGeometry(awnW, 0.02, awnD - 0.04), stripeW);
        awnBack.position.set(0, -0.03, 0);
        awnGroup.add(awnBack);
        // 前縁の波形スカート（小さな三角タブ）
        for (let i = 0; i < stripeCount; i++) {
            const isRed = i % 2 === 0;
            const tab = new THREE.Mesh(new THREE.ConeGeometry(stripeWidth / 2.4, 0.28, 4),
                isRed ? stripeR : stripeW);
            tab.rotation.z = Math.PI;
            tab.rotation.y = Math.PI / 4;
            tab.position.set(-awnW / 2 + (i + 0.5) * stripeWidth, -0.16, awnD / 2);
            awnGroup.add(tab);
        }
        const awnTilt = 0.32;
        awnGroup.rotation.x = awnTilt;
        awnGroup.position.set(0, H + 0.12 - Math.sin(awnTilt) * (awnD / 2),
            0.5 + Math.cos(awnTilt) * (awnD / 2));
        group.add(awnGroup);
        // オーニングの支柱（前2本）
        for (const sx of [-1, 1]) {
            const supX = sx * (W / 2 - 0.05);
            const supportTopY = awnGroup.position.y - Math.sin(awnTilt) * (awnD / 2);
            const supportTopZ = awnGroup.position.z + Math.cos(awnTilt) * (awnD / 2);
            const supL = Math.hypot(supportTopZ - 0.5, supportTopY - H);
            const sup = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, supL, 5), woodDark);
            sup.position.set(supX, (supportTopY + H) / 2, (supportTopZ + 0.5) / 2);
            sup.rotation.x = Math.atan2(supportTopZ - 0.5, supportTopY - H);
            group.add(sup);
        }

        // === スロープ式陳列台（傾斜した木箱トレイの段） ===
        const trayCount = 3;
        const trayW = W - 0.6;
        for (let r = 0; r < trayCount; r++) {
            const stepY = 0.45 + r * 0.32;
            const stepZ = 1.3 - r * 0.42;
            // トレイ本体（傾斜）
            const tray = new THREE.Mesh(new THREE.BoxGeometry(trayW, 0.08, 0.55), woodMid);
            tray.position.set(0, stepY, stepZ);
            tray.rotation.x = -0.32;
            tray.castShadow = true;
            tray.receiveShadow = true;
            group.add(tray);
            // トレイ前縁（高い）
            const front = new THREE.Mesh(new THREE.BoxGeometry(trayW, 0.18, 0.06), woodDark);
            front.position.set(0, stepY - 0.05, stepZ + Math.cos(-0.32) * 0.28);
            front.rotation.x = -0.32;
            group.add(front);
            // 仕切り
            for (let div = -2; div <= 2; div++) {
                const sep = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.5), woodDark);
                sep.position.set(div * trayW / 5, stepY + 0.05, stepZ);
                sep.rotation.x = -0.32;
                group.add(sep);
            }
            // 野菜を並べる
            const veggieKinds = [
                { color: 0xE85A20, geom: 'sphere', size: 0.11 },  // オレンジ
                { color: 0xD8302E, geom: 'sphere', size: 0.1 },   // トマト
                { color: 0x52168A, geom: 'eggplant', size: 0.1 }, // 茄子
                { color: 0xF4DA48, geom: 'sphere', size: 0.1 },   // レモン
                { color: 0x3A7A2A, geom: 'cabbage', size: 0.16 }, // キャベツ
                { color: 0xB05828, geom: 'sphere', size: 0.1 },   // 柿
                { color: 0xC44030, geom: 'apple', size: 0.11 },   // りんご
            ];
            const kind = veggieKinds[(r * 2 + Math.floor(Math.random() * 3)) % veggieKinds.length];
            const items = 11;
            for (let k = 0; k < items; k++) {
                const lx = -trayW / 2 + 0.18 + (k % 6) * ((trayW - 0.36) / 5);
                const lz = -0.08 + Math.floor(k / 6) * 0.16;
                const veggieMat = new THREE.MeshStandardMaterial({
                    color: kind.color + Math.floor((Math.random() - 0.5) * 0x101010),
                    roughness: 0.65,
                });
                let v;
                if (kind.geom === 'eggplant') {
                    v = new THREE.Mesh(new THREE.CylinderGeometry(kind.size * 0.6, kind.size, kind.size * 2.0, 8),
                        veggieMat);
                    v.rotation.x = Math.PI / 2 - 0.32;
                } else if (kind.geom === 'cabbage') {
                    v = new THREE.Mesh(new THREE.IcosahedronGeometry(kind.size, 0), veggieMat);
                } else if (kind.geom === 'apple') {
                    v = new THREE.Mesh(new THREE.SphereGeometry(kind.size, 8, 6), veggieMat);
                    v.scale.set(1, 0.92, 1);
                } else {
                    v = new THREE.Mesh(new THREE.SphereGeometry(kind.size, 8, 6), veggieMat);
                }
                // 傾斜上に座らせる
                const localY = stepY + kind.size + 0.04 + Math.cos(-0.32) * lz;
                const localZ = stepZ + Math.sin(0.32) * lz + Math.cos(-0.32) * lz;
                v.position.set(lx, localY, stepZ + lz - 0.05);
                group.add(v);
            }
        }

        // === 吊り野菜（玉ねぎ/にんにくの束）===
        for (let h = 0; h < 3; h++) {
            const hx = -W / 2 + 0.7 + h * ((W - 1.4) / 2);
            const stringMat = new THREE.MeshStandardMaterial({ color: 0xC8A858, roughness: 1.0 });
            // ヒモ
            const str = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 4), stringMat);
            str.position.set(hx, H - 0.4, 0.55);
            group.add(str);
            // 玉ねぎの束（小球の連なり）
            for (let b = 0; b < 4; b++) {
                const onionColor = (h % 2 === 0) ? 0xC8A05A : 0xE4D8B0;
                const onionMat = new THREE.MeshStandardMaterial({ color: onionColor, roughness: 0.85 });
                const onion = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6), onionMat);
                onion.position.set(hx + (b % 2 ? 0.07 : -0.07), H - 0.7 - b * 0.13, 0.55);
                onion.scale.set(1, 0.9, 1);
                group.add(onion);
            }
        }

        // === 黒板看板（前面、商品リスト風） ===
        const board = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.85, 0.06), chalkboard);
        board.position.set(-W / 2 + 0.7, 1.3, 1.45);
        board.rotation.y = -0.25;
        group.add(board);
        const boardFrame = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.95, 0.03), woodDark);
        boardFrame.position.set(-W / 2 + 0.7, 1.3, 1.43);
        boardFrame.rotation.y = -0.25;
        group.add(boardFrame);
        // チョークの行（5本）
        for (let i = 0; i < 5; i++) {
            const len = 0.5 + Math.random() * 0.4;
            const ln = new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, 0.01), chalk);
            ln.position.set(-W / 2 + 0.7 - 0.18 + Math.cos(-0.25) * 0.03,
                1.55 - i * 0.14,
                1.48 + Math.sin(-0.25) * 0.18);
            ln.rotation.y = -0.25;
            group.add(ln);
        }
        // 黒板の脚
        for (const sx of [-0.4, 0.4]) {
            const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.0, 0.05), woodDark);
            leg.position.set(-W / 2 + 0.7 + Math.cos(-0.25) * sx, 0.5, 1.45 - Math.sin(-0.25) * sx);
            leg.rotation.y = -0.25;
            group.add(leg);
        }

        // === 屋号の緑看板（上の梁に取り付け） ===
        const signGreen = new THREE.Mesh(new THREE.BoxGeometry(W - 0.5, 0.55, 0.1), greenSign);
        signGreen.position.set(0, H + 0.32, 0.62);
        group.add(signGreen);
        // 看板の縁
        const signFrame = new THREE.Mesh(new THREE.BoxGeometry(W - 0.4, 0.62, 0.06), yellowSign);
        signFrame.position.set(0, H + 0.32, 0.59);
        group.add(signFrame);
        // 黄色文字（簡易シルエット: 3文字分）
        for (let i = 0; i < 3; i++) {
            const cx = -0.8 + i * 0.8;
            const ch1 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 0.02), yellowSign);
            ch1.position.set(cx, H + 0.45, 0.68);
            group.add(ch1);
            const ch2 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 0.02), yellowSign);
            ch2.position.set(cx, H + 0.32, 0.68);
            group.add(ch2);
            const ch3 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.32, 0.02), yellowSign);
            ch3.position.set(cx, H + 0.32, 0.68);
            group.add(ch3);
        }

        // === 地面のかご（積み重ね）===
        const basketStack = new THREE.Group();
        for (let i = 0; i < 3; i++) {
            const b = new THREE.Mesh(new THREE.CylinderGeometry(0.32 - i * 0.02, 0.34 - i * 0.02, 0.22, 10, 1, true), wicker);
            b.position.set(0, 0.11 + i * 0.18, 0);
            basketStack.add(b);
            // 縁のリム
            const rim = new THREE.Mesh(new THREE.TorusGeometry(0.32 - i * 0.02, 0.018, 4, 16), woodDark);
            rim.rotation.x = Math.PI / 2;
            rim.position.set(0, 0.22 + i * 0.18, 0);
            basketStack.add(rim);
        }
        basketStack.position.set(W / 2 - 0.5, 0, 1.3);
        group.add(basketStack);

        // === 単独カゴ（前のスイカ）===
        const meleBasket = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.36, 0.28, 12, 1, true), wicker);
        meleBasket.position.set(W / 2 - 0.45, 0.14, 0.5);
        group.add(meleBasket);
        // スイカ（緑のしましま球）
        for (let i = 0; i < 3; i++) {
            const watermelonMat = new THREE.MeshStandardMaterial({ color: 0x2A6628, roughness: 0.6 });
            const w = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), watermelonMat);
            w.position.set(W / 2 - 0.45 + (Math.random() - 0.5) * 0.25, 0.34 + i * 0.04,
                0.5 + (Math.random() - 0.5) * 0.18);
            group.add(w);
            // しましま（黒い帯）
            for (let s = 0; s < 4; s++) {
                const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.012, 4, 12, Math.PI),
                    new THREE.MeshStandardMaterial({ color: 0x0a200a, roughness: 0.7 }));
                stripe.rotation.x = Math.PI / 2;
                stripe.rotation.z = s * Math.PI / 4;
                stripe.position.copy(w.position);
                group.add(stripe);
            }
        }

        // === 価格札（数個、トレイ前）===
        for (let i = 0; i < 3; i++) {
            const px = -W / 2 + 1.2 + i * 1.2;
            const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.18), chalk);
            tag.position.set(px, 0.55, 1.6);
            tag.rotation.x = -0.3;
            group.add(tag);
            // 価格表示の黒線
            for (let l = 0; l < 2; l++) {
                const ln = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.025), inkMat);
                ln.position.set(px, 0.59 - l * 0.05, 1.605);
                ln.rotation.x = -0.3;
                group.add(ln);
            }
        }

        return group;
    }

    /** 後半ステージかどうか（startZ ベース） */
    // 200→420 に引き上げ（Wave3 で重量プロップが一斉に湧いてジオメトリ激増→
    // メモリ圧クリーンアップ→エフェクト消失/点滅 を起こさないように、Wave5 以降から段階的に投入）
    _isLateStage(z) {
        return z > 420;
    }

    _isMidStage(z) {
        // wave 5〜7 相当: 軍事工業地帯（煙突・クレーン・残骸）
        // 220→460 に引き上げ
        return z > 460;
    }

    _isHeavyStage(z) {
        // wave 8〜11 相当: 戦地（破壊された装甲車・対空陣地・燃える施設）
        return z > 450;
    }

    _isFinalStage(z) {
        // wave 12+ 相当: 反乱軍要塞（巨大旗・サーチライト・遺跡）
        return z > 680;
    }

    // 終盤の新Wave(13〜22)をスクロール距離で近似判定。
    // main.js の既定スクロール速度 5 と各 wave.duration の積から境界を推定。
    // 13: 1880+ / 14: 2080+ / 15: 2270+ / 16: 2470+ / 17: 2700+
    // 18: 2940+ / 19: 3160+ / 20: 3390+ / 21: 3630+ / 22: 3880+
    _getEndgamePhase(z) {
        if (z > 3880) return 9; // Wave 22+
        if (z > 3630) return 8; // Wave 21
        if (z > 3390) return 7; // Wave 20
        if (z > 3160) return 6; // Wave 19
        if (z > 2940) return 5; // Wave 18
        if (z > 2700) return 4; // Wave 17
        if (z > 2470) return 3; // Wave 16
        if (z > 2270) return 2; // Wave 15
        if (z > 2080) return 1; // Wave 14
        if (z > 1880) return 0; // Wave 13
        return -1;
    }

    /* ========================================================
     *  DIORAMA VILLAGE - コンセプト画像 06_metal_slug_diorama.jpg 準拠
     *  フラット屋根アドベ＋ヴィガ（突き出し梁）、洗濯物の物干、
     *  陶器棚、装飾石壁、吊りシミター
     * ======================================================== */

    /** フラット屋根アドベ家屋（ヴィガ突き出し梁付き、北アフリカ伝統建築） */
    _buildFlatAdobeHouse(group) {
        const adobeColors = [0xD8AE7C, 0xC89868, 0xCBA078, 0xBE8E58, 0xD4A878, 0xE2BC8A];
        const c = adobeColors[Math.floor(Math.random() * adobeColors.length)];
        const adobeMat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.96 });
        const adobeShade = new THREE.MeshStandardMaterial({
            color: new THREE.Color(c).multiplyScalar(0.78), roughness: 0.98,
        });
        const adobeLight = new THREE.MeshStandardMaterial({
            color: new THREE.Color(c).multiplyScalar(1.12), roughness: 0.95,
        });
        const vigaMat = new THREE.MeshStandardMaterial({ color: 0x4A2E18, roughness: 0.95 });
        const darkWoodMat = new THREE.MeshStandardMaterial({ color: 0x3A2410, roughness: 0.95 });
        const windowMat = new THREE.MeshStandardMaterial({ color: 0x0A0805, roughness: 1.0 });

        // === メイン棟（横長で大きい） ===
        const w = 7.5 + Math.random() * 2.0;   // 7.5〜9.5（旧: 4.5〜6）
        const h = 5.0 + Math.random() * 1.5;   // 5.0〜6.5（旧: 3.2〜4.4）
        const d = 4.2 + Math.random() * 1.2;   // 4.2〜5.4（旧: 3.0〜4.0）

        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), adobeMat);
        body.position.y = h / 2;
        body.castShadow = true;
        body.receiveShadow = true;
        group.add(body);

        // L字配置: 横にもう一棟（少し背を低くして段差感を出す）
        const wingW = w * 0.55;
        const wingH = h * 0.78;
        const wingD = d * 0.85;
        const wingX = -w / 2 - wingW / 2 + 0.4;
        const wing = new THREE.Mesh(new THREE.BoxGeometry(wingW, wingH, wingD), adobeShade);
        wing.position.set(wingX, wingH / 2, (Math.random() - 0.5) * 0.8);
        wing.castShadow = true;
        wing.receiveShadow = true;
        group.add(wing);

        // パラペット (張り出し屋根縁) — メイン
        const parapet = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.3, 0.45, d + 0.3),
            adobeShade
        );
        parapet.position.y = h + 0.18;
        group.add(parapet);
        // パラペット縁の上端ハイライト
        const parapetCap = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.32, 0.08, d + 0.32),
            adobeLight
        );
        parapetCap.position.y = h + 0.42;
        group.add(parapetCap);

        // パラペット — ウィング棟
        const wingParapet = new THREE.Mesh(
            new THREE.BoxGeometry(wingW + 0.25, 0.36, wingD + 0.25),
            adobeShade
        );
        wingParapet.position.set(wingX, wingH + 0.14, wing.position.z);
        group.add(wingParapet);

        // === ヴィガ（屋根を支える突き出し梁）— 大きく長く強調 ===
        const vigaCount = 6 + Math.floor(Math.random() * 3);
        for (let i = 0; i < vigaCount; i++) {
            const xOff = -w / 2 + 0.6 + i * (w - 1.2) / (vigaCount - 1);
            for (const side of [-1, 1]) {
                const viga = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.13, 0.15, 1.4, 7),
                    vigaMat
                );
                viga.rotation.x = Math.PI / 2;
                viga.position.set(xOff, h - 0.45, side * (d / 2 + 0.6));
                viga.castShadow = true;
                group.add(viga);
                // ヴィガ先端の節
                const knot = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.16, 0.16, 0.08, 6),
                    darkWoodMat
                );
                knot.rotation.x = Math.PI / 2;
                knot.position.set(xOff, h - 0.45, side * (d / 2 + 1.25));
                group.add(knot);
            }
        }
        // ウィング棟のヴィガ
        const wVigaCount = 4;
        for (let i = 0; i < wVigaCount; i++) {
            const xOff = wingX - wingW / 2 + 0.5 + i * (wingW - 1) / (wVigaCount - 1);
            const viga = new THREE.Mesh(
                new THREE.CylinderGeometry(0.11, 0.13, 1.1, 6),
                vigaMat
            );
            viga.rotation.x = Math.PI / 2;
            viga.position.set(xOff, wingH - 0.4, wing.position.z + wingD / 2 + 0.5);
            group.add(viga);
        }

        // === 大きな深窓（リセスされた窓）—  正面 ===
        const winRows = 2;
        const winsPerRow = 2 + Math.floor(Math.random() * 2);
        for (let r = 0; r < winRows; r++) {
            for (let i = 0; i < winsPerRow; i++) {
                const wx = -w / 2 + 0.9 + i * ((w - 1.8) / Math.max(winsPerRow - 1, 1));
                const wy = 1.4 + r * (h - 2.4) / Math.max(winRows - 1, 1);
                this._buildAdobeWindow(group, wx, wy, d / 2, 0.55, 0.85, vigaMat, windowMat, darkWoodMat);
            }
        }
        // ウィング棟にも窓
        if (Math.random() > 0.3) {
            this._buildAdobeWindow(group, wingX, wingH * 0.55,
                wing.position.z + wingD / 2, 0.45, 0.6, vigaMat, windowMat, darkWoodMat);
        }

        // ドア（深いアーチ風の暗い枠）
        const doorX = (Math.random() - 0.5) * (w - 2.5);
        const doorH = 2.1;
        const doorW = 1.0;
        // 開口部（暗い穴）
        const doorHole = new THREE.Mesh(
            new THREE.BoxGeometry(doorW * 0.9, doorH * 0.95, 0.15),
            windowMat
        );
        doorHole.position.set(doorX, doorH / 2, d / 2 + 0.05);
        group.add(doorHole);
        // ドア枠（木製、太め）
        const doorFrameTop = new THREE.Mesh(
            new THREE.BoxGeometry(doorW + 0.25, 0.18, 0.18),
            vigaMat
        );
        doorFrameTop.position.set(doorX, doorH + 0.08, d / 2 + 0.06);
        group.add(doorFrameTop);
        for (const sx of [-1, 1]) {
            const jamb = new THREE.Mesh(
                new THREE.BoxGeometry(0.15, doorH + 0.08, 0.12),
                vigaMat
            );
            jamb.position.set(doorX + sx * (doorW / 2 + 0.07), doorH / 2, d / 2 + 0.06);
            group.add(jamb);
        }
        // 鴨居の上の小さな日除け（板）
        const awning = new THREE.Mesh(
            new THREE.BoxGeometry(doorW + 0.6, 0.06, 0.55),
            darkWoodMat
        );
        awning.position.set(doorX, doorH + 0.32, d / 2 + 0.32);
        group.add(awning);
        // 日除けの支え
        for (const sx of [-1, 1]) {
            const brace = new THREE.Mesh(
                new THREE.CylinderGeometry(0.04, 0.05, 0.4, 5),
                vigaMat
            );
            brace.rotation.x = Math.PI / 2;
            brace.position.set(doorX + sx * (doorW / 2 + 0.15), doorH + 0.25, d / 2 + 0.22);
            group.add(brace);
        }

        // === 屋上の追加棟（2階風） ===
        if (Math.random() > 0.3) {
            const upperW = w * (0.4 + Math.random() * 0.2);
            const upperH = 1.8 + Math.random() * 0.8;
            const upperD = d * (0.55 + Math.random() * 0.2);
            const upperX = (Math.random() - 0.5) * w * 0.3;
            const upper = new THREE.Mesh(
                new THREE.BoxGeometry(upperW, upperH, upperD),
                adobeMat
            );
            upper.position.set(upperX, h + 0.45 + upperH / 2, 0);
            upper.castShadow = true;
            group.add(upper);

            // パラペット
            const upperPar = new THREE.Mesh(
                new THREE.BoxGeometry(upperW + 0.18, 0.28, upperD + 0.18),
                adobeShade
            );
            upperPar.position.set(upperX, h + 0.45 + upperH + 0.1, 0);
            group.add(upperPar);

            // 小窓
            this._buildAdobeWindow(group, upperX, h + 0.45 + upperH * 0.55,
                upperD / 2, 0.4, 0.55, vigaMat, windowMat, darkWoodMat);

            // 上層のヴィガ
            for (let i = 0; i < 3; i++) {
                const vx = upperX - upperW / 2 + 0.4 + i * (upperW - 0.8) / 2;
                for (const side of [-1, 1]) {
                    const v = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.09, 0.1, 0.85, 6),
                        vigaMat
                    );
                    v.rotation.x = Math.PI / 2;
                    v.position.set(vx, h + 0.45 + upperH - 0.3, side * (upperD / 2 + 0.3));
                    group.add(v);
                }
            }
        }

        // === 風化染み（壁の縦streaks、複数色） ===
        const streakColors = [0x6A4A2A, 0x8A6A40, 0x9A7A50];
        for (let s = 0; s < 7; s++) {
            const sc = streakColors[Math.floor(Math.random() * streakColors.length)];
            const streakMat = new THREE.MeshBasicMaterial({
                color: sc, transparent: true, opacity: 0.28 + Math.random() * 0.18,
            });
            const sw = 0.12 + Math.random() * 0.18;
            const sh = h * (0.4 + Math.random() * 0.4);
            const streak = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), streakMat);
            streak.position.set(
                -w / 2 + 0.3 + Math.random() * (w - 0.6),
                h * 0.5 + (Math.random() - 0.5) * h * 0.2,
                d / 2 + 0.06
            );
            group.add(streak);
        }
        // 苔/汚れの斑
        for (let s = 0; s < 4; s++) {
            const blot = new THREE.Mesh(
                new THREE.CircleGeometry(0.18 + Math.random() * 0.18, 6),
                new THREE.MeshBasicMaterial({
                    color: 0x6A5A38, transparent: true, opacity: 0.3,
                })
            );
            blot.scale.set(1.4, 0.8, 1);
            blot.position.set(
                -w / 2 + Math.random() * w,
                0.3 + Math.random() * (h - 0.6),
                d / 2 + 0.07
            );
            group.add(blot);
        }
        // 下部の砂溜まりライン
        const baseDirt = new THREE.Mesh(
            new THREE.PlaneGeometry(w + 0.4, 0.5),
            new THREE.MeshBasicMaterial({
                color: 0x8A6A40, transparent: true, opacity: 0.4,
            })
        );
        baseDirt.position.set(0, 0.25, d / 2 + 0.08);
        group.add(baseDirt);

        // === 屋根の小道具（壺・薪・洗濯カゴ） ===
        const roofClutter = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < roofClutter; i++) {
            const choice = Math.random();
            if (choice < 0.4) {
                // 壺
                const pot = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.22, 0.28, 0.5, 8),
                    new THREE.MeshStandardMaterial({ color: 0x8B4A20, roughness: 0.85 })
                );
                pot.position.set(
                    (Math.random() - 0.5) * w * 0.6,
                    h + 0.55,
                    (Math.random() - 0.5) * d * 0.5
                );
                group.add(pot);
            } else if (choice < 0.75) {
                // 薪束
                const wood = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.2, 0.2, 0.7, 8),
                    vigaMat
                );
                wood.rotation.z = Math.PI / 2;
                wood.position.set(
                    (Math.random() - 0.5) * w * 0.6,
                    h + 0.4,
                    (Math.random() - 0.5) * d * 0.5
                );
                group.add(wood);
            } else {
                // カゴ
                const basket = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.32, 0.28, 0.32, 8),
                    new THREE.MeshStandardMaterial({ color: 0xA88454, roughness: 0.95 })
                );
                basket.position.set(
                    (Math.random() - 0.5) * w * 0.6,
                    h + 0.42,
                    (Math.random() - 0.5) * d * 0.5
                );
                group.add(basket);
            }
        }

        // === 中東風 装飾デコレーション ===
        // 物干しロープ（屋根下、正面）— 50% で配置
        if (Math.random() > 0.4) {
            const ropeY = h + 0.05 - 0.4 - Math.random() * 0.3;
            const margin = 0.6;
            this._addClothesline(
                group,
                -w / 2 + margin,
                w / 2 - margin,
                ropeY,
                d / 2 + 0.18,
                { count: 4 + Math.floor(Math.random() * 3), sag: 0.18 }
            );
        }
        // 蔓植物（壁を這う）— 30% で配置
        if (Math.random() > 0.5) {
            const vineX = (Math.random() - 0.5) * (w - 1.2);
            this._addHangingVines(
                group, vineX, h + 0.4, d / 2 + 0.06,
                1.4 + Math.random() * 1.0,
                { stemCount: 2 + Math.floor(Math.random() * 2) }
            );
        }
        // ペナント紐（屋上から正面下方向に斜めに）— 40% で配置
        if (Math.random() > 0.5) {
            this._addPennantString(
                group,
                -w / 2 + 0.2, h + 0.6, d / 2 - 0.1,
                w / 2 - 0.2, h + 0.2 + Math.random() * 0.4, d / 2 + 0.4,
                7 + Math.floor(Math.random() * 3)
            );
        }
        // 屋上の煙突（35% で配置）
        if (Math.random() > 0.6) {
            const cx = (Math.random() - 0.5) * w * 0.5;
            const cz = (Math.random() - 0.5) * d * 0.4;
            this._addRoofChimney(group, cx, h + 0.4, cz);
        }
        // 屋上の鉢植え（45% で配置）
        if (Math.random() > 0.5) {
            const px = (Math.random() - 0.5) * w * 0.5;
            this._addPotPlantCluster(
                group, px, h + 0.4, -d / 2 + 0.4 + Math.random() * 0.3,
                2 + Math.floor(Math.random() * 2)
            );
        }
        // 軒先の布屋根（35% で配置、ドアの反対側）
        if (Math.random() > 0.6) {
            const cnx = -doorX * 0.6 + (Math.random() - 0.5) * 1.2;
            this._addFabricCanopy(
                group,
                cnx, 2.3 + Math.random() * 0.4, d / 2 - 0.05,
                1.6 + Math.random() * 0.5,
                0.85,
                [0xD66B3A, 0x4A8DBC, 0xCB3E7A, 0x6FAA3C][Math.floor(Math.random() * 4)]
            );
        }
        // 壁掛けタペストリー（25% で配置）
        if (Math.random() > 0.7) {
            const tx = (Math.random() - 0.5) * (w - 1.6);
            this._addWallTapestry(
                group, tx, 1.6 + Math.random() * 0.4, d / 2 + 0.12,
                0.85, 1.3
            );
        }

        return group;
    }

    /** 深いリセスのある adobe 様式の窓を作る共通ヘルパー */
    _buildAdobeWindow(group, x, y, zFront, w, h, frameMat, holeMat, lintelMat) {
        // 暗い穴（深く凹ませる）
        const hole = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, 0.18),
            holeMat
        );
        hole.position.set(x, y, zFront + 0.04);
        group.add(hole);
        // 木製の枠（リセス感を出す）
        const frameW = w + 0.18;
        const frameH = h + 0.18;
        // 上枠（まぐさ）
        const lintel = new THREE.Mesh(
            new THREE.BoxGeometry(frameW + 0.12, 0.12, 0.16),
            lintelMat
        );
        lintel.position.set(x, y + h / 2 + 0.06, zFront + 0.06);
        group.add(lintel);
        // 下枠（敷居）
        const sill = new THREE.Mesh(
            new THREE.BoxGeometry(frameW + 0.12, 0.1, 0.18),
            lintelMat
        );
        sill.position.set(x, y - h / 2 - 0.05, zFront + 0.07);
        group.add(sill);
        // 縦枠
        for (const sx of [-1, 1]) {
            const jamb = new THREE.Mesh(
                new THREE.BoxGeometry(0.09, frameH, 0.14),
                frameMat
            );
            jamb.position.set(x + sx * (w / 2 + 0.045), y, zFront + 0.05);
            group.add(jamb);
        }
        // 十字格子（mullion）
        const mull = new THREE.Mesh(
            new THREE.BoxGeometry(w * 0.92, 0.05, 0.08),
            lintelMat
        );
        mull.position.set(x, y, zFront + 0.10);
        group.add(mull);
        const mullV = new THREE.Mesh(
            new THREE.BoxGeometry(0.05, h * 0.92, 0.08),
            lintelMat
        );
        mullV.position.set(x, y, zFront + 0.10);
        group.add(mullV);
    }

    /* ========================================================
     *  中東風 装飾ヘルパー（建物に追加する小道具群）
     *    - 物干し竿/ロープ（カラフルな洗濯物）
     *    - 蔓植物（壁を這う緑）
     *    - ペナント紐（三角旗の連鎖）
     *    - 鉢植え／植木壺
     *    - 煙突＋小さな煙の塊
     *    - 屋根上の物干しラック
     *    - 軒先の布屋根（テント風）
     *    - 壁掛け絨毯/タペストリー
     * ======================================================== */

    /** 物干しロープ + 吊り下がる洗濯物。建物の正面/側面に配置 */
    _addClothesline(group, x1, x2, y, z, opts = {}) {
        const cg = new THREE.Group();
        const ropeMat = new THREE.MeshStandardMaterial({ color: 0x8C7050, roughness: 0.95 });
        const length = Math.abs(x2 - x1);
        const sag = opts.sag || 0.18;
        // 中央のたるみを表現するため、3区間で結ぶ
        const segs = 3;
        for (let i = 0; i < segs; i++) {
            const t1 = i / segs;
            const t2 = (i + 1) / segs;
            const sx1 = x1 + (x2 - x1) * t1;
            const sx2 = x1 + (x2 - x1) * t2;
            const sy1 = y - sag * Math.sin(Math.PI * t1);
            const sy2 = y - sag * Math.sin(Math.PI * t2);
            const segLen = Math.hypot(sx2 - sx1, sy2 - sy1);
            const rope = new THREE.Mesh(
                new THREE.CylinderGeometry(0.018, 0.018, segLen, 4),
                ropeMat
            );
            rope.position.set((sx1 + sx2) / 2, (sy1 + sy2) / 2, z);
            rope.rotation.z = Math.atan2(sy2 - sy1, sx2 - sx1) - Math.PI / 2;
            cg.add(rope);
        }
        // 物干しの両端ポール（壁に固定するブラケット風）
        const bracketMat = new THREE.MeshStandardMaterial({ color: 0x5A3A1A, roughness: 0.9 });
        for (const px of [x1, x2]) {
            const bracket = new THREE.Mesh(
                new THREE.CylinderGeometry(0.04, 0.05, 0.45, 5),
                bracketMat
            );
            bracket.rotation.z = Math.PI / 2;
            bracket.position.set(px, y, z - 0.18);
            cg.add(bracket);
        }
        // 洗濯物（カラフルな布、ランダムサイズ）
        const clothColors = [0xD8543A, 0x3A6FA0, 0xE8B940, 0xF0DCB0, 0x6F8C3A, 0xBC4582, 0xD68B40, 0x4A8DA8];
        const itemCount = opts.count || 5;
        for (let i = 0; i < itemCount; i++) {
            const t = (i + 0.5) / itemCount;
            const cx = x1 + (x2 - x1) * t;
            const cy = y - sag * Math.sin(Math.PI * t);
            const cw = 0.32 + Math.random() * 0.22;
            const ch = 0.55 + Math.random() * 0.35;
            const color = clothColors[Math.floor(Math.random() * clothColors.length)];
            const cloth = new THREE.Mesh(
                new THREE.PlaneGeometry(cw, ch),
                new THREE.MeshStandardMaterial({
                    color, roughness: 0.92, side: THREE.DoubleSide,
                })
            );
            cloth.position.set(cx, cy - ch / 2 - 0.04, z);
            cloth.rotation.z = (Math.random() - 0.5) * 0.18;
            // 風になびく感じで Y 軸まわりに少しひねる
            cloth.rotation.y = (Math.random() - 0.5) * 0.4;
            cg.add(cloth);
            // 洗濯ばさみ風の小さな点
            const peg = new THREE.Mesh(
                new THREE.BoxGeometry(0.06, 0.04, 0.04),
                bracketMat
            );
            peg.position.set(cx, cy + 0.02, z + 0.02);
            cg.add(peg);
        }
        group.add(cg);
        return cg;
    }

    /** 壁を這う蔓植物（葉のクラスタ） */
    _addHangingVines(group, x, yTop, z, span = 1.8, opts = {}) {
        const vg = new THREE.Group();
        const stemMat = new THREE.MeshStandardMaterial({ color: 0x4A6B2A, roughness: 0.9 });
        const leafMatA = new THREE.MeshStandardMaterial({
            color: 0x5C8A3A, roughness: 0.85, side: THREE.DoubleSide,
        });
        const leafMatB = new THREE.MeshStandardMaterial({
            color: 0x3A6A28, roughness: 0.88, side: THREE.DoubleSide,
        });
        const flowerMat = new THREE.MeshStandardMaterial({
            color: opts.flowerColor || 0xC85A8A, roughness: 0.7, emissive: 0x2A0A18, emissiveIntensity: 0.2,
        });
        // 主茎（蛇行する垂直線）
        const stemCount = opts.stemCount || 3;
        for (let s = 0; s < stemCount; s++) {
            const sx = x + (s - (stemCount - 1) / 2) * 0.35;
            const sl = span * (0.7 + Math.random() * 0.5);
            const stem = new THREE.Mesh(
                new THREE.CylinderGeometry(0.025, 0.02, sl, 4),
                stemMat
            );
            stem.position.set(sx, yTop - sl / 2, z);
            stem.rotation.z = (Math.random() - 0.5) * 0.15;
            vg.add(stem);
            // 葉のクラスタ
            const leafCount = Math.floor(sl * 5);
            for (let l = 0; l < leafCount; l++) {
                const t = l / leafCount;
                const ly = yTop - sl * t;
                const leaf = new THREE.Mesh(
                    new THREE.PlaneGeometry(0.18, 0.14),
                    Math.random() > 0.5 ? leafMatA : leafMatB
                );
                const lateral = (Math.random() - 0.5) * 0.5;
                leaf.position.set(sx + lateral, ly, z + 0.04);
                leaf.rotation.z = (Math.random() - 0.5) * 1.2;
                leaf.rotation.y = (Math.random() - 0.5) * 0.6;
                vg.add(leaf);
            }
            // 末端の小さな花（確率）
            if (Math.random() > 0.4) {
                const flower = new THREE.Mesh(
                    new THREE.SphereGeometry(0.06, 6, 4),
                    flowerMat
                );
                flower.position.set(sx + (Math.random() - 0.5) * 0.2, yTop - sl + 0.05, z + 0.06);
                vg.add(flower);
            }
        }
        group.add(vg);
        return vg;
    }

    /** 三角ペナント紐（屋上から軒下へ斜めに張る色とりどりの旗） */
    _addPennantString(group, ax, ay, az, bx, by, bz, count = 8) {
        const pg = new THREE.Group();
        const ropeMat = new THREE.MeshStandardMaterial({ color: 0x6A4A28, roughness: 0.9 });
        const dx = bx - ax, dy = by - ay, dz = bz - az;
        const len = Math.hypot(dx, dy, dz);
        // ロープ本体
        const rope = new THREE.Mesh(
            new THREE.CylinderGeometry(0.015, 0.015, len, 4),
            ropeMat
        );
        rope.position.set((ax + bx) / 2, (ay + by) / 2 - 0.1, (az + bz) / 2);
        rope.rotation.z = Math.atan2(dy, dx) - Math.PI / 2;
        rope.rotation.x = Math.atan2(dz, Math.hypot(dx, dy));
        pg.add(rope);
        // 三角ペナント
        const pennantColors = [0xE84A2A, 0xE8C040, 0x4A8DBC, 0x6FAA3C, 0xD8528A, 0xEEDCAA];
        for (let i = 0; i < count; i++) {
            const t = (i + 0.5) / count;
            const cx = ax + dx * t;
            const cy = ay + dy * t - 0.1 - 0.05 * Math.sin(Math.PI * t); // 少したるみ
            const cz = az + dz * t;
            const color = pennantColors[i % pennantColors.length];
            const flagShape = new THREE.Shape();
            flagShape.moveTo(0, 0);
            flagShape.lineTo(0.22, -0.05);
            flagShape.lineTo(0, -0.30);
            const flagGeo = new THREE.ShapeGeometry(flagShape);
            const flag = new THREE.Mesh(
                flagGeo,
                new THREE.MeshStandardMaterial({
                    color, roughness: 0.85, side: THREE.DoubleSide,
                })
            );
            flag.position.set(cx, cy, cz + 0.02);
            flag.rotation.z = Math.atan2(dy, dx) + Math.PI;
            flag.rotation.y = (Math.random() - 0.5) * 0.5;
            pg.add(flag);
        }
        group.add(pg);
        return pg;
    }

    /** 屋上の鉢植えクラスタ（複数の壺＋緑/花） */
    _addPotPlantCluster(group, cx, cy, cz, count = 3) {
        const pg = new THREE.Group();
        const potColors = [0x8B4A22, 0x7A4018, 0xA66A38, 0x6A2E10];
        const greenA = new THREE.MeshStandardMaterial({ color: 0x4A7A2A, roughness: 0.9 });
        const greenB = new THREE.MeshStandardMaterial({ color: 0x6FAA3C, roughness: 0.85 });
        const flowerMat = new THREE.MeshStandardMaterial({
            color: 0xE85A40, roughness: 0.7,
        });
        for (let i = 0; i < count; i++) {
            const r = 0.16 + Math.random() * 0.10;
            const ph = 0.32 + Math.random() * 0.14;
            const ox = (i - (count - 1) / 2) * 0.42 + (Math.random() - 0.5) * 0.1;
            const oz = (Math.random() - 0.5) * 0.18;
            const pot = new THREE.Mesh(
                new THREE.CylinderGeometry(r * 0.85, r, ph, 8),
                new THREE.MeshStandardMaterial({
                    color: potColors[Math.floor(Math.random() * potColors.length)],
                    roughness: 0.92,
                })
            );
            pot.position.set(cx + ox, cy + ph / 2, cz + oz);
            pg.add(pot);
            // 鉢の縁
            const rim = new THREE.Mesh(
                new THREE.CylinderGeometry(r * 0.92, r * 0.85, 0.06, 8),
                new THREE.MeshStandardMaterial({ color: 0x4A2A12, roughness: 0.95 })
            );
            rim.position.set(cx + ox, cy + ph - 0.02, cz + oz);
            pg.add(rim);
            // 葉/植物
            const leaf = new THREE.Mesh(
                new THREE.SphereGeometry(r * 1.2, 8, 6),
                Math.random() > 0.5 ? greenA : greenB
            );
            leaf.scale.set(1, 0.7 + Math.random() * 0.3, 1);
            leaf.position.set(cx + ox, cy + ph + r * 0.6, cz + oz);
            pg.add(leaf);
            // ところどころ花
            if (Math.random() > 0.55) {
                for (let f = 0; f < 3; f++) {
                    const flower = new THREE.Mesh(
                        new THREE.SphereGeometry(0.05, 5, 4),
                        flowerMat
                    );
                    flower.position.set(
                        cx + ox + (Math.random() - 0.5) * r * 1.4,
                        cy + ph + r * 0.6 + (Math.random() - 0.5) * r * 0.6,
                        cz + oz + (Math.random() - 0.5) * r * 1.4
                    );
                    pg.add(flower);
                }
            }
        }
        group.add(pg);
        return pg;
    }

    /** 屋上の煙突（小型レンガ煙突＋静止煙の塊） */
    _addRoofChimney(group, x, baseY, z) {
        const cg = new THREE.Group();
        const brickMat = new THREE.MeshStandardMaterial({ color: 0x9A5A38, roughness: 0.95 });
        const brickDk = new THREE.MeshStandardMaterial({ color: 0x6A3A20, roughness: 0.97 });
        const w = 0.42, d = 0.42, h = 0.95 + Math.random() * 0.4;
        const stack = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, d), brickMat
        );
        stack.position.set(x, baseY + h / 2, z);
        cg.add(stack);
        // レンガの目地（横線）
        for (let r = 0; r < 4; r++) {
            const line = new THREE.Mesh(
                new THREE.BoxGeometry(w + 0.02, 0.03, d + 0.02), brickDk
            );
            line.position.set(x, baseY + 0.18 + r * 0.22, z);
            cg.add(line);
        }
        // 煙突の口（暗い穴）
        const cap = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.08, 0.08, d + 0.08), brickDk
        );
        cap.position.set(x, baseY + h + 0.04, z);
        cg.add(cap);
        const hole = new THREE.Mesh(
            new THREE.BoxGeometry(w * 0.5, 0.05, d * 0.5),
            new THREE.MeshStandardMaterial({ color: 0x111111 })
        );
        hole.position.set(x, baseY + h + 0.06, z);
        cg.add(hole);
        // 静止煙（半透明の球を3つ重ねる）
        const smokeMat = new THREE.MeshStandardMaterial({
            color: 0xC8C0B0, transparent: true, opacity: 0.55, roughness: 1.0,
        });
        for (let s = 0; s < 3; s++) {
            const puff = new THREE.Mesh(
                new THREE.SphereGeometry(0.18 + s * 0.06, 6, 5),
                smokeMat
            );
            puff.position.set(
                x + (Math.random() - 0.5) * 0.12 + s * 0.06,
                baseY + h + 0.25 + s * 0.22,
                z + (Math.random() - 0.5) * 0.12
            );
            cg.add(puff);
        }
        group.add(cg);
        return cg;
    }

    /** 軒先の布屋根（テント風の柔らかい布、両端は柱で支える） */
    _addFabricCanopy(group, cx, cy, cz, w = 1.8, d = 0.9, color = 0xD66B3A) {
        const cg = new THREE.Group();
        const fabricMat = new THREE.MeshStandardMaterial({
            color, roughness: 0.92, side: THREE.DoubleSide,
        });
        const trimMat = new THREE.MeshStandardMaterial({
            color: 0xE8C870, roughness: 0.85, side: THREE.DoubleSide,
        });
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x5A3A1A, roughness: 0.92 });
        // 屋根布（少したわむように 3 セグメント）
        for (let i = 0; i < 3; i++) {
            const t1 = i / 3;
            const t2 = (i + 1) / 3;
            const sag1 = -0.08 * Math.sin(Math.PI * t1);
            const sag2 = -0.08 * Math.sin(Math.PI * t2);
            const segW = w / 3;
            const seg = new THREE.Mesh(
                new THREE.PlaneGeometry(segW + 0.005, d),
                fabricMat
            );
            seg.position.set(
                cx - w / 2 + segW * (i + 0.5),
                cy + (sag1 + sag2) / 2,
                cz + d / 2
            );
            seg.rotation.x = -Math.PI / 2 - 0.2 + (sag2 - sag1) * 1.5;
            cg.add(seg);
        }
        // 縞模様の縁取り（前縁にだけ細い帯）
        const trim = new THREE.Mesh(
            new THREE.BoxGeometry(w, 0.05, 0.08),
            trimMat
        );
        trim.position.set(cx, cy - 0.05, cz + d + 0.02);
        cg.add(trim);
        // スカロップ（波状の前縁）
        const scallopCount = Math.floor(w / 0.3);
        for (let s = 0; s < scallopCount; s++) {
            const sc = new THREE.Mesh(
                new THREE.ConeGeometry(0.15, 0.22, 3, 1),
                fabricMat
            );
            sc.position.set(
                cx - w / 2 + 0.15 + s * (w / scallopCount),
                cy - 0.18,
                cz + d + 0.04
            );
            sc.rotation.x = Math.PI;
            sc.scale.set(1, 1, 0.3);
            cg.add(sc);
        }
        // 前縁の支柱
        for (const sx of [-1, 1]) {
            const pole = new THREE.Mesh(
                new THREE.CylinderGeometry(0.04, 0.05, 1.4, 5),
                poleMat
            );
            pole.position.set(cx + sx * w / 2, cy - 0.7, cz + d);
            cg.add(pole);
        }
        group.add(cg);
        return cg;
    }

    /** 壁掛けタペストリー（中東モチーフのカラフルな織物） */
    _addWallTapestry(group, x, y, z, w = 0.9, h = 1.4) {
        const tg = new THREE.Group();
        // 5 色の縞模様で「絨毯」感を出す
        const stripeColors = [0xB23A2A, 0x2E5F8C, 0xE2B040, 0xCFB890, 0x6A2E1A, 0x3A6F4A];
        const stripeCount = 7;
        const stripeH = h / stripeCount;
        for (let i = 0; i < stripeCount; i++) {
            const color = stripeColors[(i * 2) % stripeColors.length];
            const stripe = new THREE.Mesh(
                new THREE.PlaneGeometry(w, stripeH * 0.96),
                new THREE.MeshStandardMaterial({ color, roughness: 0.92, side: THREE.DoubleSide })
            );
            stripe.position.set(x, y + h / 2 - stripeH * (i + 0.5), z);
            tg.add(stripe);
            // 細かい菱形パターン（小さな点を中央に配置）
            if (i % 2 === 1) {
                const diamondMat = new THREE.MeshBasicMaterial({ color: 0xEEDCAA });
                const dCount = Math.max(2, Math.floor(w / 0.18));
                for (let d = 0; d < dCount; d++) {
                    const dx = -w / 2 + 0.12 + d * (w - 0.24) / Math.max(dCount - 1, 1);
                    const diamond = new THREE.Mesh(
                        new THREE.PlaneGeometry(0.06, 0.06),
                        diamondMat
                    );
                    diamond.rotation.z = Math.PI / 4;
                    diamond.position.set(x + dx, y + h / 2 - stripeH * (i + 0.5), z + 0.005);
                    tg.add(diamond);
                }
            }
        }
        // 上縁の吊り棒
        const rod = new THREE.Mesh(
            new THREE.CylinderGeometry(0.025, 0.025, w + 0.18, 5),
            new THREE.MeshStandardMaterial({ color: 0x5A3A1A, roughness: 0.9 })
        );
        rod.rotation.z = Math.PI / 2;
        rod.position.set(x, y + h / 2 + 0.04, z + 0.015);
        tg.add(rod);
        // 房（下端のフリンジ）
        const fringeMat = new THREE.MeshStandardMaterial({ color: 0xEEDCAA, roughness: 0.9 });
        for (let f = 0; f < 8; f++) {
            const fx = -w / 2 + 0.06 + f * (w - 0.12) / 7;
            const tassel = new THREE.Mesh(
                new THREE.CylinderGeometry(0.012, 0.012, 0.08, 4),
                fringeMat
            );
            tassel.position.set(x + fx, y - h / 2 - 0.04, z + 0.005);
            tg.add(tassel);
        }
        group.add(tg);
        return tg;
    }

    /** 装飾された石壁（コンセプト画像中央右の彫刻入りの壁） */
    _buildDecoratedStoneWall(group) {
        // 上部の漆喰部 — 装飾モチーフが描かれる明るい面
        const plasterColor = 0xCFB890;
        const plasterMat = new THREE.MeshStandardMaterial({
            color: plasterColor, roughness: 0.96, flatShading: true,
        });
        const plasterShade = new THREE.MeshStandardMaterial({
            color: new THREE.Color(plasterColor).multiplyScalar(0.78), roughness: 0.98,
        });
        // 下部の石ブロック（土台）
        const stoneMat = new THREE.MeshStandardMaterial({
            color: 0xA89878, roughness: 0.95, flatShading: true,
        });
        const stoneShade = new THREE.MeshStandardMaterial({
            color: 0x807058, roughness: 0.98, flatShading: true,
        });

        // === 大型化 ===
        const w = 5.8;     // 旧: 3.6
        const h = 5.6;     // 旧: 4.0
        const d = 0.7;     // 旧: 0.5

        // 漆喰本体
        const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), plasterMat);
        wall.position.y = h / 2;
        wall.castShadow = true;
        wall.receiveShadow = true;
        group.add(wall);

        // 下部の石積み土台（高さ1.2）
        const baseH = 1.2;
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.2, baseH, d + 0.18),
            stoneMat
        );
        base.position.y = baseH / 2;
        base.castShadow = true;
        base.receiveShadow = true;
        group.add(base);

        // 石ブロックの目地（土台部のみ）
        for (let row = 0; row < 2; row++) {
            const groove = new THREE.Mesh(
                new THREE.BoxGeometry(w + 0.22, 0.05, d + 0.20),
                stoneShade
            );
            groove.position.y = 0.4 + row * 0.45;
            group.add(groove);
        }
        for (let row = 0; row < 2; row++) {
            const offset = (row % 2) * 0.45;
            for (let x = -w / 2 + 0.45 + offset; x < w / 2; x += 0.9) {
                const vGroove = new THREE.Mesh(
                    new THREE.BoxGeometry(0.05, 0.42, d + 0.22),
                    stoneShade
                );
                vGroove.position.set(x, 0.4 + row * 0.45 + 0.21, 0);
                group.add(vGroove);
            }
        }

        // 漆喰と石の境目（細い影帯）
        const seam = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.05, 0.06, d + 0.05),
            plasterShade
        );
        seam.position.y = baseH;
        group.add(seam);

        // === 装飾モチーフ（大きな唐草・渦巻き紋様） ===
        const motifMat = new THREE.MeshBasicMaterial({
            color: 0xC8521C, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
        });
        const motifMat2 = new THREE.MeshBasicMaterial({
            color: 0xA84818, transparent: true, opacity: 0.78, side: THREE.DoubleSide,
        });
        const motifMat3 = new THREE.MeshBasicMaterial({
            color: 0xE2864A, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
        });

        // 大きな中央の渦巻き（雲龍を抽象化したフォルム）
        const motifCenterY = h * 0.55;
        const motifCenterX = -w * 0.18;
        // 外周の弧（大）
        for (let i = 0; i < 8; i++) {
            const ang = (i / 8) * Math.PI * 1.6 - Math.PI * 0.2;
            const r = 1.1 - i * 0.05;
            const blob = new THREE.Mesh(
                new THREE.CircleGeometry(0.18 + i * 0.015, 10),
                i % 2 === 0 ? motifMat : motifMat2
            );
            blob.scale.set(1.5, 0.7, 1);
            blob.position.set(
                motifCenterX + Math.cos(ang) * r,
                motifCenterY + Math.sin(ang) * r * 0.7,
                d / 2 + 0.04
            );
            blob.rotation.z = ang;
            group.add(blob);
        }
        // 内側の渦
        for (let i = 0; i < 5; i++) {
            const ang = (i / 5) * Math.PI * 1.4 + Math.PI * 0.4;
            const r = 0.45 - i * 0.06;
            const swirl = new THREE.Mesh(
                new THREE.CircleGeometry(0.22 - i * 0.025, 10),
                motifMat
            );
            swirl.scale.set(1.2, 0.8, 1);
            swirl.position.set(
                motifCenterX + Math.cos(ang) * r,
                motifCenterY + Math.sin(ang) * r * 0.8 + 0.05,
                d / 2 + 0.045
            );
            swirl.rotation.z = ang + Math.PI / 2;
            group.add(swirl);
        }
        // 中央の核
        const core = new THREE.Mesh(
            new THREE.CircleGeometry(0.18, 12),
            motifMat3
        );
        core.position.set(motifCenterX, motifCenterY + 0.05, d / 2 + 0.05);
        group.add(core);

        // 右側に補助モチーフ（小さな尾の渦）
        for (let i = 0; i < 4; i++) {
            const dot = new THREE.Mesh(
                new THREE.CircleGeometry(0.15 - i * 0.02, 8),
                motifMat2
            );
            dot.scale.set(1.3, 0.6, 1);
            dot.position.set(w * 0.22 + i * 0.18, motifCenterY + 0.4 - i * 0.18, d / 2 + 0.04);
            dot.rotation.z = -0.4 + i * 0.25;
            group.add(dot);
        }

        // 上部の波線フリーズ（破風帯）
        const friezeY = h - 0.45;
        for (let i = 0; i < 7; i++) {
            const wave = new THREE.Mesh(
                new THREE.CircleGeometry(0.13, 6),
                motifMat2
            );
            wave.scale.set(2.4, 0.32, 1);
            wave.position.set(-w / 2 + 0.5 + i * (w - 1) / 6, friezeY, d / 2 + 0.04);
            wave.rotation.z = (i % 2 === 0) ? 0.1 : -0.1;
            group.add(wave);
        }

        // === 上部の小窓（深窓、複数） ===
        const winY = h * 0.78;
        const winW = 0.42;
        const winH = 0.7;
        for (const wxOff of [w * 0.30, -w * 0.42]) {
            const winHole = new THREE.Mesh(
                new THREE.BoxGeometry(winW, winH, 0.18),
                new THREE.MeshStandardMaterial({ color: 0x0A0805, roughness: 1.0 })
            );
            winHole.position.set(wxOff, winY, d / 2 + 0.06);
            group.add(winHole);
            // 木製格子
            for (const o of [-0.11, 0, 0.11]) {
                const bar = new THREE.Mesh(
                    new THREE.BoxGeometry(0.04, winH + 0.02, 0.08),
                    new THREE.MeshStandardMaterial({ color: 0x2A1A0E, roughness: 0.95 })
                );
                bar.position.set(wxOff + o, winY, d / 2 + 0.10);
                group.add(bar);
            }
            const cross = new THREE.Mesh(
                new THREE.BoxGeometry(winW + 0.02, 0.04, 0.08),
                new THREE.MeshStandardMaterial({ color: 0x2A1A0E, roughness: 0.95 })
            );
            cross.position.set(wxOff, winY, d / 2 + 0.10);
            group.add(cross);
            // 上部の小さな庇
            const cornice = new THREE.Mesh(
                new THREE.BoxGeometry(winW + 0.3, 0.1, 0.18),
                plasterShade
            );
            cornice.position.set(wxOff, winY + winH / 2 + 0.1, d / 2 + 0.07);
            group.add(cornice);
        }

        // === 上端の冠石（コーニス） ===
        const cornice = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.25, 0.18, d + 0.22),
            plasterShade
        );
        cornice.position.y = h - 0.09;
        group.add(cornice);
        const corniceCap = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.32, 0.08, d + 0.28),
            stoneMat
        );
        corniceCap.position.y = h + 0.04;
        group.add(corniceCap);

        // === 風化染み・剥落 ===
        for (let s = 0; s < 6; s++) {
            const blot = new THREE.Mesh(
                new THREE.CircleGeometry(0.18 + Math.random() * 0.22, 6),
                new THREE.MeshBasicMaterial({
                    color: 0x8A6A40, transparent: true, opacity: 0.32,
                })
            );
            blot.scale.set(1.3 + Math.random() * 0.6, 0.7 + Math.random() * 0.3, 1);
            blot.position.set(
                -w / 2 + Math.random() * w,
                baseH + 0.2 + Math.random() * (h - baseH - 0.6),
                d / 2 + 0.05
            );
            group.add(blot);
        }

        // === 中東風 装飾 ===
        // 蔓植物（壁を這う）— 強めに表現
        if (Math.random() > 0.3) {
            this._addHangingVines(
                group,
                -w / 2 + 0.6 + Math.random() * 0.6,
                h - 0.3,
                d / 2 + 0.06,
                2.0 + Math.random() * 1.0,
                { stemCount: 3, flowerColor: 0xE85A2A }
            );
        }
        if (Math.random() > 0.4) {
            this._addHangingVines(
                group,
                w / 2 - 0.6 - Math.random() * 0.6,
                h - 0.3,
                d / 2 + 0.06,
                1.6 + Math.random() * 1.2,
                { stemCount: 2, flowerColor: 0xC85A8A }
            );
        }
        // ペナント紐（壁の上端から斜めに）
        if (Math.random() > 0.5) {
            this._addPennantString(
                group,
                -w / 2 + 0.2, h + 0.15, d / 2 - 0.05,
                w / 2 - 0.2, h - 0.6 + Math.random() * 0.4, d / 2 + 0.3,
                8 + Math.floor(Math.random() * 3)
            );
        }
        // 物干しロープ（壁中段に水平）
        if (Math.random() > 0.55) {
            this._addClothesline(
                group,
                -w / 2 + 0.5, w / 2 - 0.5,
                h * 0.55,
                d / 2 + 0.15,
                { count: 5, sag: 0.16 }
            );
        }
        // 壁掛けタペストリー
        if (Math.random() > 0.45) {
            this._addWallTapestry(
                group,
                (Math.random() - 0.5) * (w - 1.4),
                h * 0.6,
                d / 2 + 0.10,
                0.95, 1.5
            );
        }

        return group;
    }

    /** 物干し（2本の柱の間にロープを張り、色とりどりの布／ラグを吊るす） */
    _buildHangingLaundry(group) {
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x6A4422, roughness: 0.95 });
        const woodMatDk = new THREE.MeshStandardMaterial({ color: 0x4A2E18, roughness: 0.95 });

        // === 大型化: 柱を高く、間隔を広く ===
        const postH = 3.4;          // 旧: 2.4
        const postSpacing = 6.4;    // 旧: 3.6

        // 2本の柱（角材っぽく）
        for (const xOff of [-postSpacing / 2, postSpacing / 2]) {
            const post = new THREE.Mesh(
                new THREE.BoxGeometry(0.18, postH, 0.18),
                woodMat
            );
            post.position.set(xOff, postH / 2, 0);
            post.castShadow = true;
            group.add(post);

            // 柱頂部の冠
            const cap = new THREE.Mesh(
                new THREE.BoxGeometry(0.28, 0.16, 0.28),
                woodMatDk
            );
            cap.position.set(xOff, postH + 0.08, 0);
            group.add(cap);

            // 根元の支え（地面側）
            const baseStone = new THREE.Mesh(
                new THREE.BoxGeometry(0.34, 0.18, 0.34),
                new THREE.MeshStandardMaterial({ color: 0x9A8868, roughness: 0.96 })
            );
            baseStone.position.set(xOff, 0.09, 0);
            group.add(baseStone);

            // 斜めの控え（X字補強）
            for (const dir of [-1, 1]) {
                const brace = new THREE.Mesh(
                    new THREE.BoxGeometry(0.06, 0.7, 0.06),
                    woodMatDk
                );
                brace.position.set(xOff + dir * 0.18, 0.45, 0);
                brace.rotation.z = dir * 0.4;
                group.add(brace);
            }
        }

        // ロープ（複数、サギング曲線を多角形で近似）
        const ropeMat = new THREE.MeshStandardMaterial({ color: 0xA08858, roughness: 1.0 });
        const ropeYOffs = [postH - 0.12, postH - 0.55, postH - 0.95];
        const ropeSagAmts = [0.18, 0.28, 0.22];
        const ropeSegs = 8;
        const ropeLen = postSpacing - 0.2;
        const ropePoints = []; // [yOff][seg] 後で布のY参照に使う
        for (let r = 0; r < ropeYOffs.length; r++) {
            const yBase = ropeYOffs[r];
            const sag = ropeSagAmts[r];
            const segPts = [];
            for (let s = 0; s < ropeSegs; s++) {
                const t = s / (ropeSegs - 1);
                const x = -ropeLen / 2 + t * ropeLen;
                // 放物線でサギング
                const y = yBase - sag * (1 - (2 * t - 1) * (2 * t - 1));
                segPts.push({ x, y });
            }
            // 線分でロープを表現
            for (let s = 0; s < segPts.length - 1; s++) {
                const a = segPts[s], b = segPts[s + 1];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const segLen = Math.sqrt(dx * dx + dy * dy);
                const seg = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.025, 0.025, segLen, 4),
                    ropeMat
                );
                seg.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
                seg.rotation.z = Math.PI / 2 + Math.atan2(dy, dx);
                group.add(seg);
            }
            ropePoints.push(segPts);
        }

        // === 吊り下げる布／ラグ（カラフルでパターン豊か） ===
        const fabricColors = [
            { base: 0xC44848, accent: 0xE8C868, accent2: 0x6A2A1A },  // 赤×金×濃赤
            { base: 0x4A6FA0, accent: 0xE8E0C8, accent2: 0x223E5A },  // 青×クリーム×紺
            { base: 0xC88848, accent: 0x4A2E18, accent2: 0xE8C868 },  // オレンジ×茶×黄
            { base: 0x88B0A0, accent: 0xE8C868, accent2: 0x3E5E58 },  // ターコイズ×金×深緑
            { base: 0xA85838, accent: 0xE8C8A0, accent2: 0x602A18 },  // テラコッタ×ベージュ×焦茶
            { base: 0x6B8E5A, accent: 0xE0D8B8, accent2: 0x3A4E30 },  // オリーブ×ベージュ×深緑
            { base: 0x884A6E, accent: 0xE8B868, accent2: 0x4A2640 },  // 紫×黄×暗紫
            { base: 0xD8A468, accent: 0x8B3E1A, accent2: 0xF0DAB0 },  // 砂金×赤茶×象牙
        ];

        // 上段ロープには大きな布、中段には中サイズ、下段には小さい布
        const ropeConfigs = [
            { yOffIdx: 0, count: 3, fHRange: [1.5, 2.0], drape: true },   // 上段: 大判ラグ
            { yOffIdx: 1, count: 4, fHRange: [0.8, 1.3], drape: false },  // 中段
            { yOffIdx: 2, count: 5, fHRange: [0.55, 0.85], drape: false }, // 下段
        ];

        for (const cfg of ropeConfigs) {
            const segPts = ropePoints[cfg.yOffIdx];
            const sectionW = ropeLen / cfg.count;
            for (let i = 0; i < cfg.count; i++) {
                const col = fabricColors[Math.floor(Math.random() * fabricColors.length)];
                const xPos = -ropeLen / 2 + sectionW * (i + 0.5);
                // ロープのY位置を補間
                const t = (xPos + ropeLen / 2) / ropeLen;
                const ti = Math.min(segPts.length - 2, Math.floor(t * (segPts.length - 1)));
                const ts = t * (segPts.length - 1) - ti;
                const ropeY = segPts[ti].y * (1 - ts) + segPts[ti + 1].y * ts;

                const fW = sectionW * (0.55 + Math.random() * 0.3);
                const fH = cfg.fHRange[0] + Math.random() * (cfg.fHRange[1] - cfg.fHRange[0]);
                const fY = ropeY;

                const fabricMat = new THREE.MeshStandardMaterial({
                    color: col.base, roughness: 0.95, side: THREE.DoubleSide,
                });

                // ドレープ式: ロープにかけて二つ折り (V字風)
                if (cfg.drape && Math.random() > 0.4) {
                    const halfH = fH * 0.55;
                    for (const fSide of [-1, 1]) {
                        const drape = new THREE.Mesh(
                            new THREE.PlaneGeometry(fW, halfH),
                            fabricMat
                        );
                        drape.position.set(
                            xPos + fSide * fW * 0.05,
                            fY - halfH / 2,
                            fSide * 0.04
                        );
                        drape.rotation.y = fSide * 0.18;
                        drape.rotation.x = (Math.random() - 0.5) * 0.05;
                        group.add(drape);
                        // パターン縞
                        for (let s = 0; s < 4; s++) {
                            const stripe = new THREE.Mesh(
                                new THREE.PlaneGeometry(fW * 0.95, 0.05),
                                new THREE.MeshStandardMaterial({
                                    color: s % 2 === 0 ? col.accent : col.accent2,
                                    roughness: 0.95, side: THREE.DoubleSide,
                                })
                            );
                            stripe.position.set(
                                xPos + fSide * fW * 0.05,
                                fY - 0.15 - s * (halfH - 0.2) / 4,
                                fSide * 0.045
                            );
                            stripe.rotation.y = fSide * 0.18;
                            group.add(stripe);
                        }
                    }
                    // 中央の幾何学モチーフ
                    if (Math.random() > 0.4) {
                        const motif = new THREE.Mesh(
                            new THREE.PlaneGeometry(fW * 0.45, halfH * 0.4),
                            new THREE.MeshStandardMaterial({
                                color: col.accent, roughness: 0.95, side: THREE.DoubleSide,
                            })
                        );
                        motif.position.set(xPos, fY - halfH * 0.5, 0.05);
                        motif.rotation.z = Math.PI / 4;
                        group.add(motif);
                    }
                    continue;
                }

                // 通常の吊り下げ式
                const fabric = new THREE.Mesh(
                    new THREE.PlaneGeometry(fW, fH),
                    fabricMat
                );
                fabric.position.set(xPos, fY - fH / 2 - 0.04, (Math.random() - 0.5) * 0.06);
                fabric.rotation.y = (Math.random() - 0.5) * 0.15;
                fabric.rotation.z = (Math.random() - 0.5) * 0.04;
                group.add(fabric);

                // 縦縞 or 横縞 (層を増やしてパターン豊か)
                const horizontal = Math.random() > 0.5;
                const stripeCount = 4 + Math.floor(Math.random() * 3);
                for (let s = 0; s < stripeCount; s++) {
                    const sCol = (s % 3 === 0) ? col.accent : col.accent2;
                    const stripeMat = new THREE.MeshStandardMaterial({
                        color: sCol, roughness: 0.95, side: THREE.DoubleSide,
                    });
                    const sw = horizontal ? fW * 0.95 : fW * 0.06;
                    const sh = horizontal ? 0.05 + Math.random() * 0.04 : fH * 0.95;
                    const stripe = new THREE.Mesh(
                        new THREE.PlaneGeometry(sw, sh),
                        stripeMat
                    );
                    if (horizontal) {
                        const yOffP = -fH * 0.4 + (s / Math.max(stripeCount - 1, 1)) * fH * 0.8;
                        stripe.position.set(xPos, fY - fH / 2 + yOffP - 0.04, fabric.position.z + 0.005);
                    } else {
                        const xOffP = -fW * 0.4 + (s / Math.max(stripeCount - 1, 1)) * fW * 0.8;
                        stripe.position.set(xPos + xOffP, fY - fH / 2 - 0.04, fabric.position.z + 0.005);
                    }
                    stripe.rotation.y = fabric.rotation.y;
                    group.add(stripe);
                }

                // 中央のひし形 or 円のモチーフ
                if (Math.random() > 0.35) {
                    const motifSize = Math.min(fW, fH) * 0.32;
                    const motif = new THREE.Mesh(
                        Math.random() > 0.5
                            ? new THREE.PlaneGeometry(motifSize, motifSize)
                            : new THREE.CircleGeometry(motifSize * 0.5, 10),
                        new THREE.MeshStandardMaterial({
                            color: col.accent, roughness: 0.95, side: THREE.DoubleSide,
                        })
                    );
                    motif.position.set(xPos, fY - fH * 0.5 - 0.04, fabric.position.z + 0.008);
                    motif.rotation.set(0, fabric.rotation.y, Math.PI / 4);
                    group.add(motif);
                    // 内側の小ダイヤ
                    const inner = new THREE.Mesh(
                        new THREE.PlaneGeometry(motifSize * 0.4, motifSize * 0.4),
                        new THREE.MeshStandardMaterial({
                            color: col.accent2, roughness: 0.95, side: THREE.DoubleSide,
                        })
                    );
                    inner.position.set(xPos, fY - fH * 0.5 - 0.04, fabric.position.z + 0.012);
                    inner.rotation.set(0, fabric.rotation.y, Math.PI / 4);
                    group.add(inner);
                }

                // 房（フリンジ）— 下端
                const fringeCount = 5;
                for (let f = 0; f < fringeCount; f++) {
                    const fx = xPos - fW * 0.4 + (f / (fringeCount - 1)) * fW * 0.8;
                    const fringe = new THREE.Mesh(
                        new THREE.BoxGeometry(0.025, 0.08 + Math.random() * 0.05, 0.02),
                        new THREE.MeshStandardMaterial({
                            color: col.accent, roughness: 0.95,
                        })
                    );
                    fringe.position.set(fx, fY - fH - 0.04, fabric.position.z + 0.01);
                    group.add(fringe);
                }

                // 留めピン（洗濯ばさみ）
                for (const pinOff of [-fW * 0.4, fW * 0.4]) {
                    const pin = new THREE.Mesh(
                        new THREE.BoxGeometry(0.07, 0.1, 0.05),
                        new THREE.MeshStandardMaterial({ color: 0x3A2410, roughness: 0.95 })
                    );
                    pin.position.set(xPos + pinOff, fY + 0.04, fabric.position.z);
                    group.add(pin);
                }
            }
        }

        return group;
    }

    /** 陶器棚（木の棚に多数のテラコッタ壺・アンフォラを並べる） */
    _buildPotteryShelf(group) {
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x4A2E18, roughness: 0.95 });
        const woodMatLt = new THREE.MeshStandardMaterial({ color: 0x6A4422, roughness: 0.95 });

        // === 大型化 ===
        const w = 3.8;          // 旧: 2.4
        const d = 0.95;         // 旧: 0.65
        const shelves = 4;      // 旧: 3
        const shelfH = 0.95;    // 旧: 0.85
        const totalH = shelves * shelfH;

        // 側板2枚（より太く）
        for (const xOff of [-w / 2, w / 2]) {
            const side = new THREE.Mesh(
                new THREE.BoxGeometry(0.14, totalH + 0.2, d),
                woodMat
            );
            side.position.set(xOff, (totalH + 0.2) / 2 - 0.1, 0);
            side.castShadow = true;
            group.add(side);
            // 側板の縁取り
            const edge = new THREE.Mesh(
                new THREE.BoxGeometry(0.16, totalH + 0.22, 0.06),
                woodMatLt
            );
            edge.position.set(xOff, (totalH + 0.2) / 2 - 0.1, d / 2 - 0.02);
            group.add(edge);
        }

        // 背板（縦の板組み風）
        const back = new THREE.Mesh(
            new THREE.BoxGeometry(w, totalH + 0.1, 0.08),
            new THREE.MeshStandardMaterial({ color: 0x3A2410, roughness: 0.95 })
        );
        back.position.set(0, totalH / 2, -d / 2 + 0.04);
        group.add(back);
        // 背板の縦リブ
        for (let r = -2; r <= 2; r++) {
            const rib = new THREE.Mesh(
                new THREE.BoxGeometry(0.04, totalH, 0.04),
                woodMatLt
            );
            rib.position.set(r * (w / 5), totalH / 2, -d / 2 + 0.09);
            group.add(rib);
        }

        // 棚板 + 壺
        const potColors = [
            0x8B4A20, 0x9C5028, 0xA85A30, 0x7A3E18, 0xB06038,
            0x6A3018, 0xC4682E, 0x884A28, 0x5A2810, 0xCC7842,
        ];
        const accentColors = [0xE8C868, 0xC44848, 0x4A6FA0, 0x2A1A0E];

        for (let s = 0; s < shelves; s++) {
            const yShelf = (s + 1) * shelfH - 0.05;
            const board = new THREE.Mesh(
                new THREE.BoxGeometry(w + 0.06, 0.1, d - 0.04),
                woodMat
            );
            board.position.set(0, yShelf - 0.05, 0);
            board.castShadow = true;
            board.receiveShadow = true;
            group.add(board);
            // 棚板の前縁（明色）
            const boardEdge = new THREE.Mesh(
                new THREE.BoxGeometry(w + 0.08, 0.06, 0.06),
                woodMatLt
            );
            boardEdge.position.set(0, yShelf - 0.06, d / 2 - 0.02);
            group.add(boardEdge);

            // 棚板上の壺を並べる（5〜7個）
            const potsPerShelf = 5 + Math.floor(Math.random() * 3);
            for (let p = 0; p < potsPerShelf; p++) {
                const px = -w / 2 + 0.3 + p * ((w - 0.6) / Math.max(potsPerShelf - 1, 1));
                const pz = (Math.random() - 0.5) * (d - 0.3);
                const r = 0.16 + Math.random() * 0.12;
                const ph = r * (1.6 + Math.random() * 1.0);
                const color = potColors[Math.floor(Math.random() * potColors.length)];

                // 壺本体（Lathe で膨らみのプロファイル）
                const points = [];
                const segs = 8;
                const profile = Math.floor(Math.random() * 3); // 0:アンフォラ 1:つぼ 2:水差し
                for (let i = 0; i <= segs; i++) {
                    const t = i / segs;
                    const py = t * ph;
                    let pr;
                    if (profile === 0) {
                        // アンフォラ（細口）
                        if (t < 0.1) pr = r * (0.5 + t * 3.0);
                        else if (t < 0.55) pr = r * (0.95 + Math.sin((t - 0.1) * Math.PI / 0.9) * 0.4);
                        else if (t < 0.85) pr = r * (1.1 - (t - 0.55) * 1.4);
                        else pr = r * 0.5;
                    } else if (profile === 1) {
                        // 丸つぼ
                        if (t < 0.15) pr = r * (0.55 + t * 2.5);
                        else if (t < 0.6) pr = r * (1.0 + Math.sin((t - 0.15) * Math.PI / 0.9) * 0.35);
                        else pr = r * (0.95 - (t - 0.6) * 0.7);
                    } else {
                        // 円柱気味
                        if (t < 0.12) pr = r * (0.7 + t * 2.0);
                        else if (t < 0.85) pr = r * (0.95 + Math.sin(t * Math.PI * 1.2) * 0.1);
                        else pr = r * (0.95 - (t - 0.85) * 0.5);
                    }
                    points.push(new THREE.Vector2(Math.max(pr, 0.04), py));
                }
                const pot = new THREE.Mesh(
                    new THREE.LatheGeometry(points, 12),
                    new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
                );
                pot.position.set(px, yShelf, pz);
                pot.rotation.y = Math.random() * Math.PI;
                pot.castShadow = true;
                group.add(pot);

                // 装飾帯（壺の中央に細い色帯）
                if (Math.random() > 0.5) {
                    const bandColor = accentColors[Math.floor(Math.random() * accentColors.length)];
                    const band = new THREE.Mesh(
                        new THREE.CylinderGeometry(r * 1.05, r * 1.05, 0.04, 12),
                        new THREE.MeshStandardMaterial({ color: bandColor, roughness: 0.85 })
                    );
                    band.position.set(px, yShelf + ph * 0.55, pz);
                    group.add(band);
                }

                // ハンドル（耳）
                if (profile === 0 || Math.random() > 0.55) {
                    for (const sd of [-1, 1]) {
                        const handle = new THREE.Mesh(
                            new THREE.TorusGeometry(0.08, 0.018, 4, 10, Math.PI),
                            new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
                        );
                        handle.position.set(px + sd * r * 0.85, yShelf + ph * 0.6, pz);
                        handle.rotation.y = sd > 0 ? -Math.PI / 2 : Math.PI / 2;
                        handle.rotation.z = Math.PI / 2;
                        group.add(handle);
                    }
                }
            }
        }

        // === 棚の上に飾りの大きな壺（2〜3個） ===
        const topPotCount = 2 + Math.floor(Math.random() * 2);
        for (let p = 0; p < topPotCount; p++) {
            const tr = 0.22 + Math.random() * 0.12;
            const tph = tr * (2.0 + Math.random() * 0.5);
            const tColor = potColors[Math.floor(Math.random() * potColors.length)];
            const pts = [];
            for (let i = 0; i <= 8; i++) {
                const t = i / 8;
                let pr;
                if (t < 0.1) pr = tr * (0.5 + t * 3.5);
                else if (t < 0.55) pr = tr * (1.0 + Math.sin((t - 0.1) * Math.PI / 0.9) * 0.4);
                else pr = tr * (1.0 - (t - 0.55) * 1.0);
                pts.push(new THREE.Vector2(Math.max(pr, 0.05), t * tph));
            }
            const bigPot = new THREE.Mesh(
                new THREE.LatheGeometry(pts, 12),
                new THREE.MeshStandardMaterial({ color: tColor, roughness: 0.85 })
            );
            const tx = -w / 2 + 0.5 + p * (w - 1) / Math.max(topPotCount - 1, 1);
            bigPot.position.set(tx, totalH + 0.04, 0);
            group.add(bigPot);
        }

        // === 棚の下に床置きの大型アンフォラ（3〜4個、密集） ===
        const floorPotCount = 3 + Math.floor(Math.random() * 2);
        for (let p = 0; p < floorPotCount; p++) {
            const fr = 0.28 + Math.random() * 0.14;
            const fph = fr * (2.2 + Math.random() * 0.6);
            const fColor = potColors[Math.floor(Math.random() * potColors.length)];
            const pts = [];
            for (let i = 0; i <= 9; i++) {
                const t = i / 9;
                let pr;
                if (t < 0.12) pr = fr * (0.55 + t * 2.5);
                else if (t < 0.55) pr = fr * (1.0 + Math.sin((t - 0.12) * Math.PI / 0.86) * 0.35);
                else if (t < 0.85) pr = fr * (1.05 - (t - 0.55) * 1.3);
                else pr = fr * 0.55;
                pts.push(new THREE.Vector2(Math.max(pr, 0.06), t * fph));
            }
            const pot = new THREE.Mesh(
                new THREE.LatheGeometry(pts, 14),
                new THREE.MeshStandardMaterial({ color: fColor, roughness: 0.85 })
            );
            pot.position.set(
                -w / 2 + 0.5 + p * (w - 1) / Math.max(floorPotCount - 1, 1),
                0,
                d / 2 + 0.35 + (Math.random() - 0.5) * 0.3
            );
            pot.castShadow = true;
            group.add(pot);
            // 大壺の取っ手
            for (const sd of [-1, 1]) {
                const handle = new THREE.Mesh(
                    new THREE.TorusGeometry(0.1, 0.025, 4, 10, Math.PI),
                    new THREE.MeshStandardMaterial({ color: fColor, roughness: 0.85 })
                );
                handle.position.set(
                    pot.position.x + sd * fr * 0.85,
                    fph * 0.55,
                    pot.position.z
                );
                handle.rotation.y = sd > 0 ? -Math.PI / 2 : Math.PI / 2;
                handle.rotation.z = Math.PI / 2;
                group.add(handle);
            }
        }

        // 棚の手前に積まれた小壺（散らかし感）
        const messyCount = 2 + Math.floor(Math.random() * 3);
        for (let m = 0; m < messyCount; m++) {
            const mr = 0.12 + Math.random() * 0.08;
            const mh = mr * 1.5;
            const mColor = potColors[Math.floor(Math.random() * potColors.length)];
            const sm = new THREE.Mesh(
                new THREE.CylinderGeometry(mr, mr * 1.1, mh, 10),
                new THREE.MeshStandardMaterial({ color: mColor, roughness: 0.85 })
            );
            sm.position.set(
                -w / 2 + 0.4 + Math.random() * (w - 0.8),
                mh / 2,
                d / 2 + 0.65 + Math.random() * 0.25
            );
            sm.rotation.z = (Math.random() - 0.5) * 0.4;
            group.add(sm);
        }

        return group;
    }

    /** 吊りシミター（壁掛け装飾の湾刀）— 単独でも壁にも置ける */
    _buildHangingScimitar(group) {
        // ブレード（湾曲した薄板）
        const bladeMat = new THREE.MeshStandardMaterial({
            color: 0xCFCFCF, roughness: 0.4, metalness: 0.85,
        });
        // 湾刀のシルエット — 平面を使って曲げる
        const bladeShape = new THREE.Shape();
        bladeShape.moveTo(0, 0);
        bladeShape.quadraticCurveTo(0.6, 0.05, 1.2, -0.15);
        bladeShape.quadraticCurveTo(0.65, 0.05, 0.0, 0.05);
        const bladeGeo = new THREE.ShapeGeometry(bladeShape);
        const blade = new THREE.Mesh(bladeGeo, bladeMat);
        blade.position.set(-0.6, 1.6, 0);
        blade.rotation.z = -0.25;
        group.add(blade);

        // ブレードの背側（暗いライン）
        const bladeBack = new THREE.Mesh(
            new THREE.BoxGeometry(1.2, 0.04, 0.02),
            new THREE.MeshStandardMaterial({ color: 0x9A9A9A, roughness: 0.5, metalness: 0.7 })
        );
        bladeBack.position.set(0, 1.65, 0.02);
        bladeBack.rotation.z = -0.18;
        group.add(bladeBack);

        // 柄（ハンドル）
        const handleMat = new THREE.MeshStandardMaterial({ color: 0x6A2810, roughness: 0.85 });
        const handle = new THREE.Mesh(
            new THREE.CylinderGeometry(0.05, 0.05, 0.32, 8),
            handleMat
        );
        handle.position.set(-0.7, 1.78, 0);
        handle.rotation.z = -0.25 + Math.PI / 2;
        group.add(handle);

        // ガード（鍔）
        const guardMat = new THREE.MeshStandardMaterial({
            color: 0xCFA050, roughness: 0.45, metalness: 0.75,
        });
        const guard = new THREE.Mesh(
            new THREE.BoxGeometry(0.08, 0.18, 0.12),
            guardMat
        );
        guard.position.set(-0.55, 1.7, 0);
        guard.rotation.z = -0.25;
        group.add(guard);

        // 柄頭（ポンメル）
        const pommel = new THREE.Mesh(
            new THREE.SphereGeometry(0.07, 8, 6),
            guardMat
        );
        pommel.position.set(-0.83, 1.85, 0);
        group.add(pommel);

        // 吊りロープ／革紐（柄から上へ）
        const ropeMat = new THREE.MeshStandardMaterial({ color: 0x4A2E18, roughness: 1.0 });
        const rope = new THREE.Mesh(
            new THREE.CylinderGeometry(0.012, 0.012, 0.6, 4),
            ropeMat
        );
        rope.position.set(-0.83, 2.15, 0);
        group.add(rope);

        return group;
    }

    /** 屋根上のサテライト集合（壺・薪・洗濯カゴなど） */
    _buildRooftopProps(group) {
        const choice = Math.random();
        if (choice < 0.4) {
            // 薪の山
            const woodMat = new THREE.MeshStandardMaterial({ color: 0x6A4422, roughness: 0.95 });
            for (let i = 0; i < 6; i++) {
                const log = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.06, 0.07, 0.55, 6),
                    woodMat
                );
                log.rotation.z = Math.PI / 2;
                log.position.set((Math.random() - 0.5) * 0.4, 0.06 + Math.floor(i / 3) * 0.13, (Math.random() - 0.5) * 0.4);
                log.rotation.y = (Math.random() - 0.5) * 0.3;
                group.add(log);
            }
        } else if (choice < 0.75) {
            // 大壺
            const potMat = new THREE.MeshStandardMaterial({ color: 0x8B4A20, roughness: 0.85 });
            const pot = new THREE.Mesh(
                new THREE.CylinderGeometry(0.22, 0.28, 0.5, 10),
                potMat
            );
            pot.position.y = 0.25;
            group.add(pot);
            const lid = new THREE.Mesh(
                new THREE.SphereGeometry(0.2, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2),
                potMat
            );
            lid.position.y = 0.5;
            group.add(lid);
        } else {
            // 洗濯カゴ
            const basketMat = new THREE.MeshStandardMaterial({ color: 0x7A5A30, roughness: 1.0 });
            const basket = new THREE.Mesh(
                new THREE.CylinderGeometry(0.28, 0.22, 0.3, 10, 1, true),
                basketMat
            );
            basket.position.y = 0.15;
            group.add(basket);
            // カゴの中の布
            const cloth = new THREE.Mesh(
                new THREE.SphereGeometry(0.22, 8, 5),
                new THREE.MeshStandardMaterial({ color: 0xC44848, roughness: 0.95 })
            );
            cloth.scale.y = 0.4;
            cloth.position.y = 0.32;
            group.add(cloth);
        }
        return group;
    }

    /* ========================================================
     *  GROUND - 砂漠の地面（頂点カラーで変化をつける）
     * ======================================================== */
    _buildGround() {
        // メイン地面: 頂点カラーで砂紋の変化をつける
        // 奥行きを ±90 まで拡張して遠景シルエット (z≈+95) と写真パネル (z≈+78) まで
        // 砂地が連続するようにし、地平線手前の Z ギャップを解消する
        const groundGeo = new THREE.PlaneGeometry(220, 180, 110, 90);
        const colors = [];
        // パレットを写真背景のヘイズに馴染むよう、ハイライト/シャドウのコントラストを抑制
        const baseColor = new THREE.Color(0xD4A868);
        const shadowColor = new THREE.Color(0xA47A40);
        const highlightColor = new THREE.Color(0xE6C384);
        const tanColor = new THREE.Color(0xC4965A);
        const hazeColor = new THREE.Color(0xE8C890); // 遠景の写真と一致する暖色のヘイズ
        const pos = groundGeo.attributes.position;
        // 簡易フラクタルノイズ
        const fnoise = (x, y) => (
            Math.sin(x * 0.18) * 0.45 +
            Math.sin(y * 0.27 + 1.3) * 0.35 +
            Math.sin(x * 0.55 + y * 0.22) * 0.18 +
            Math.sin(x * 1.4 + y * 1.7) * 0.08 +
            (Math.random() - 0.5) * 0.14
        );
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i);
            const y = pos.getY(i);
            const n = fnoise(x, y);
            const c = new THREE.Color();
            if (n > 0.35) {
                c.copy(highlightColor).lerp(baseColor, 1 - Math.min(1, (n - 0.35) * 1.5));
            } else if (n > 0.05) {
                c.copy(baseColor).lerp(highlightColor, (n - 0.05) * 0.8);
            } else if (n < -0.35) {
                c.copy(shadowColor).lerp(tanColor, 1 - Math.min(1, (-n - 0.35) * 1.5));
            } else if (n < -0.05) {
                c.copy(tanColor).lerp(shadowColor, (-n - 0.05) * 0.8);
            } else {
                c.copy(baseColor);
            }
            // 道路帯（|x|<5）はやや明るく踏み固められた色
            if (Math.abs(x) < 5) {
                c.lerp(new THREE.Color(0xC89868), 0.35);
            }
            // 遠方の地面（local +Y が大きい = 前方）はヘイズ色に向かってブレンド
            // 0 → 1 を [30, 80] でフェードして地平線が写真と滑らかに接続される
            const farT = Math.max(0, Math.min(1, (y - 30) / 50));
            const hazeStrength = farT * 0.55;
            if (hazeStrength > 0) c.lerp(hazeColor, hazeStrength);
            // 後方の地面（local -Y が大きい）は軽くトーンを暗めにして奥行き感を出す
            const backT = Math.max(0, Math.min(1, (-y - 30) / 50));
            if (backT > 0) c.lerp(shadowColor, backT * 0.20);
            colors.push(c.r, c.g, c.b);
            // 砂丘の起伏 + 細かい砂紋（遠方は起伏を抑えて滑らかに地平線へ繋ぐ）
            const farDamp = 1 - farT * 0.7;
            const dune = (Math.sin(x * 0.07) * 0.18 + Math.cos(y * 0.11) * 0.12) * farDamp;
            const ripple = Math.sin(x * 0.9 + y * 0.4) * 0.025 * farDamp;
            pos.setZ(i, Math.abs(x) > 6 ? dune + ripple : ripple * 0.4);
        }
        groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        groundGeo.computeVertexNormals();

        const groundMat = new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.98,
            metalness: 0.0,
            flatShading: false,
        });
        this.groundMesh = new THREE.Mesh(groundGeo, groundMat);
        this.groundMesh.rotation.x = -Math.PI / 2;
        this.groundMesh.position.y = -0.01;
        this.groundMesh.receiveShadow = true;
        this.scene.add(this.groundMesh);

        // 地面の道路/踏み固められた道（プレイ領域）— +Z 方向に沿って長い帯
        const roadGeo = new THREE.PlaneGeometry(8, 200);
        const roadMat = new THREE.MeshStandardMaterial({
            color: 0xBA9466,
            roughness: 0.92,
        });
        this.roadMesh = new THREE.Mesh(roadGeo, roadMat);
        this.roadMesh.rotation.x = -Math.PI / 2;
        this.roadMesh.position.y = 0.01;
        this.roadMesh.position.x = 0;
        this.roadMesh.receiveShadow = true;
        this.scene.add(this.roadMesh);

        // 道の端のわだち（暗い縞）— 道の横サイドに平行
        for (const xOff of [-2.2, 2.2]) {
            const rut = new THREE.Mesh(
                new THREE.PlaneGeometry(0.4, 200),
                new THREE.MeshStandardMaterial({ color: 0x6F5028, roughness: 0.95 })
            );
            rut.rotation.x = -Math.PI / 2;
            rut.position.set(xOff, 0.02, 0);
            this.scene.add(rut);
            this.rutMeshes = this.rutMeshes || [];
            this.rutMeshes.push(rut);
        }

        // 散らばる小石（ホットスタートな静的プロップ。スクロール追従させる）
        this.pebbleMeshes = [];
        const pebbleGeoCache = [
            new THREE.IcosahedronGeometry(0.18, 0),
            new THREE.IcosahedronGeometry(0.13, 0),
            new THREE.IcosahedronGeometry(0.22, 0),
        ];
        const pebbleMatA = new THREE.MeshStandardMaterial({ color: 0x8C6A3C, roughness: 0.95, flatShading: true });
        const pebbleMatB = new THREE.MeshStandardMaterial({ color: 0xB89060, roughness: 0.92, flatShading: true });
        for (let i = 0; i < 60; i++) {
            const geo = pebbleGeoCache[i % pebbleGeoCache.length];
            const mat = (i % 2 === 0) ? pebbleMatA : pebbleMatB;
            const stone = new THREE.Mesh(geo, mat);
            const lateral = (Math.random() - 0.5) * 80;
            // 道路上には置かない
            if (Math.abs(lateral) < 5) continue;
            stone.position.set(
                lateral,
                Math.random() * 0.05,
                (Math.random() - 0.5) * 90
            );
            stone.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
            stone.scale.setScalar(0.6 + Math.random() * 1.1);
            stone.castShadow = true;
            stone.receiveShadow = true;
            this.scene.add(stone);
            this.pebbleMeshes.push({ mesh: stone, baseZ: stone.position.z });
        }

        // タイヤ痕（道路に沿った薄い茶色のドット列）
        this.trackDots = [];
        const trackMat = new THREE.MeshBasicMaterial({
            color: 0x6E5028, transparent: true, opacity: 0.55, depthWrite: false,
        });
        const trackGeo = new THREE.PlaneGeometry(0.18, 0.6);
        for (let i = 0; i < 40; i++) {
            const z = -50 + i * 2.5 + (Math.random() - 0.5) * 0.6;
            for (const xOff of [-1.6, 1.6]) {
                const dot = new THREE.Mesh(trackGeo, trackMat);
                dot.rotation.x = -Math.PI / 2;
                dot.position.set(xOff, 0.015, z);
                this.scene.add(dot);
                this.trackDots.push({ mesh: dot, baseZ: z });
            }
        }
    }

    /* ========================================================
     *  CHUNKS - 地上の小道具・障害物（縦スクロール 3D 版）
     *  startZ: チャンクの開始 Z 座標（進行方向）
     *  オブジェクトの +Z が進行方向。±X は横スプレッド。
     * ======================================================== */
    _generateChunk(startZ) {
        const chunk = { startZ, objects: [] };

        const tag = (obj, type, radius, hp = 1, opts = {}) => {
            obj.userData.obstacle = {
                type, radius, hp,
                destroyed: false,
                explosionVisual: opts.explosionVisual || (opts.explosive ? 'large' : 'small'),
                explosive: !!opts.explosive,
                blastRadius: opts.blastRadius || 0,
                dropChance: opts.dropChance || 0,
                dropTable: opts.dropTable || null,
                score: opts.score || 0,
            };
            return obj;
        };

        const place = (obj, lateralRange = 10) => {
            obj.position.set(
                (Math.random() - 0.5) * lateralRange * 2,
                0,
                startZ + Math.random() * this.chunkSize
            );
            this.scene.add(obj);
            chunk.objects.push(obj);
            return obj;
        };

        // 土嚢（ほぼ毎チャンク・複数列）
        if (Math.random() > 0.05) tag(place(this._buildSandbags(), 10), 'destructible', 1.2);
        if (Math.random() > 0.45) tag(place(this._buildSandbags(), 10), 'destructible', 1.2);
        // 木箱
        if (Math.random() > 0.15) tag(place(this._buildCrates(), 10), 'destructible', 0.9);
        // ドラム缶（赤ドラム量産）
        if (Math.random() > 0.2) tag(place(this._buildBarrels(), 10), 'destructible', 1.0);
        if (Math.random() > 0.6) tag(place(this._buildBarrels(), 9), 'destructible', 1.0);
        // 鉄条網
        if (Math.random() > 0.35) tag(place(this._buildBarbedWire(), 9), 'destructible', 1.4);
        // テント
        if (Math.random() > 0.5) tag(place(this._buildTent(), 9), 'destructible', 1.5);
        // 壊れた壁（弾痕付きにふさわしい数量）
        if (Math.random() > 0.4) tag(place(this._buildBrokenWall(), 9), 'block', 1.8);
        // 木製の橋/桟橋（装飾、当たり判定なし）
        if (Math.random() > 0.8) place(this._buildWoodenBridge(), 7);
        // サボテン（砂漠の象徴）- 道の外側に置く
        if (Math.random() > 0.5) {
            const cactus = this._buildCactus();
            cactus.position.set(
                (Math.random() > 0.5 ? 1 : -1) * (6 + Math.random() * 3),
                0,
                startZ + Math.random() * this.chunkSize
            );
            this.scene.add(cactus);
            chunk.objects.push(cactus);
            tag(cactus, 'destructible', 0.7);
        }
        // 岩の塊（中型: 戦車では砕けない）
        if (Math.random() > 0.4) tag(place(this._buildRockCluster(), 12), 'block', 1.2);
        // 砂山（装飾）
        if (Math.random() > 0.6) place(this._buildSandPile(), 12);
        // 動物の骨/ドクロ（装飾）
        if (Math.random() > 0.8) place(this._buildSkullBones(), 10);
        // 砂丘の低木（装飾）
        if (Math.random() > 0.45) place(this._buildDesertShrubs(), 12);
        // 破れ布の旗杭
        if (Math.random() > 0.45) tag(place(this._buildTornBannerPost(), 10), 'destructible', 0.5);
        // 遺跡の柱片
        if (Math.random() > 0.55) tag(place(this._buildRuinPillar(), 11), 'destructible', 0.6);
        // キャラバン荷車跡
        if (Math.random() > 0.7) tag(place(this._buildCaravanCart(), 9), 'destructible', 1.5);

        // === アフリカ村プロップ（コンセプト画像 C0mVPN3lN3L6 準拠） ===
        // 土器の集まり（生活感）
        if (Math.random() > 0.35) tag(place(this._buildClayPots(new THREE.Group()), 10), 'destructible', 1.1);
        // 尖った木杭の柵（前景の境界線）— 道の両脇に置きたい
        if (Math.random() > 0.55) {
            const fence = this._buildSpikeFence(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            fence.position.set(
                side * (5.5 + Math.random() * 1.2),
                0,
                startZ + Math.random() * this.chunkSize
            );
            fence.rotation.y = side > 0 ? -Math.PI / 12 : Math.PI / 12;
            this.scene.add(fence);
            chunk.objects.push(fence);
            tag(fence, 'destructible', 1.3);
        }
        // 路傍のアカシア（道沿いに）
        if (Math.random() > 0.55) {
            const tree = this._buildAcaciaTree(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            tree.position.set(
                side * (7 + Math.random() * 4),
                0,
                startZ + Math.random() * this.chunkSize
            );
            tree.scale.setScalar(0.7 + Math.random() * 0.4);
            this.scene.add(tree);
            chunk.objects.push(tree);
            tag(tree, 'destructible', 0.8);
        }
        // 路傍のヤシの木（オアシス的に時々群生）
        if (Math.random() > 0.5) {
            const side = Math.random() > 0.5 ? 1 : -1;
            const cluster = Math.random() > 0.7 ? 2 + Math.floor(Math.random() * 2) : 1;
            const baseZ = startZ + Math.random() * this.chunkSize;
            const baseX = side * (7.5 + Math.random() * 3.5);
            for (let p = 0; p < cluster; p++) {
                const palm = this._buildPalmTree(new THREE.Group());
                palm.position.set(
                    baseX + (Math.random() - 0.5) * 1.6,
                    0,
                    baseZ + (p - (cluster - 1) / 2) * (1.4 + Math.random() * 0.6)
                );
                palm.rotation.y = Math.random() * Math.PI * 2;
                palm.scale.setScalar(0.85 + Math.random() * 0.35);
                this.scene.add(palm);
                chunk.objects.push(palm);
                tag(palm, 'destructible', 0.9);
            }
        }
        // 単独の小屋（地上レベル: 大型建造物 — ダイナミックに大きく）
        if (Math.random() > 0.7) {
            const hutRadius = 1.8 + Math.random() * 0.6;
            const hut = this._buildThatchedHut(new THREE.Group(), {
                radius: hutRadius,
                wallH: 1.8 + Math.random() * 0.5,
                roofH: 3.2 + Math.random() * 0.8,
            });
            const side = Math.random() > 0.5 ? 1 : -1;
            hut.position.set(
                side * (9 + Math.random() * 3),
                0,
                startZ + Math.random() * this.chunkSize
            );
            hut.rotation.y = Math.random() * Math.PI * 2;
            this.scene.add(hut);
            chunk.objects.push(hut);
            tag(hut, 'block', hutRadius + 0.4);
        }
        // 木製足場
        if (Math.random() > 0.78) tag(place(this._buildWoodenScaffold(new THREE.Group()), 11), 'destructible', 1.5);
        // 井戸（稀: 石造で頑丈なので block）
        if (Math.random() > 0.92) tag(place(this._buildVillageWell(new THREE.Group()), 9), 'block', 1.2);

        // === ジオラマ村プロップ（コンセプト画像 06_metal_slug_diorama 準拠） ===
        // 物干し（横幅 6.4 になったので少し離す。装飾、当たり判定なし）
        if (Math.random() > 0.62) {
            const laundry = this._buildHangingLaundry(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            laundry.position.set(
                side * (7.2 + Math.random() * 1.5),
                0,
                startZ + Math.random() * this.chunkSize
            );
            laundry.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
            this.scene.add(laundry);
            chunk.objects.push(laundry);
        }
        // 陶器棚（道沿い: 大型化に合わせ少し離す）
        if (Math.random() > 0.7) {
            const shelf = this._buildPotteryShelf(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            shelf.position.set(
                side * (6.5 + Math.random() * 1.5),
                0,
                startZ + Math.random() * this.chunkSize
            );
            shelf.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
            this.scene.add(shelf);
            chunk.objects.push(shelf);
            tag(shelf, 'destructible', 2.0);
        }
        // 装飾石壁（背景区切り: 大型建造物）
        if (Math.random() > 0.78) {
            const dWall = this._buildDecoratedStoneWall(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            dWall.position.set(
                side * (9.5 + Math.random() * 1.5),
                0,
                startZ + Math.random() * this.chunkSize
            );
            dWall.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
            this.scene.add(dWall);
            chunk.objects.push(dWall);
            tag(dWall, 'block', 3.4);
        }
        // フラット屋根アドベ家屋（アーケード演出: 巨大化）
        if (Math.random() > 0.55) {
            const house = this._buildFlatAdobeHouse(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            house.position.set(
                side * (16 + Math.random() * 4),
                0,
                startZ + Math.random() * this.chunkSize
            );
            house.rotation.y = side > 0 ? -Math.PI / 2 + (Math.random() - 0.5) * 0.3 : Math.PI / 2 + (Math.random() - 0.5) * 0.3;
            house.scale.setScalar(1.85 + Math.random() * 0.45);
            this.scene.add(house);
            chunk.objects.push(house);
            tag(house, 'block', 7.2);
        }
        // 屋根上のサテライト小道具（高所装飾、当たり判定なし）
        if (Math.random() > 0.85) {
            const props = this._buildRooftopProps(new THREE.Group());
            place(props, 9);
        }

        // === 後半ステージ専用プロップ ===
        // late / mid / heavy / final が同時に true になると 1 チャンクあたりプロップ数が
        // 21 → 35 個前後まで膨張して描画コストが急増するため、チャンクごとに最大 1 系統のみ抽選する。
        const activeStages = [];
        if (this._isLateStage(startZ))  activeStages.push('late');
        if (this._isMidStage(startZ))   activeStages.push('mid');
        if (this._isHeavyStage(startZ)) activeStages.push('heavy');
        if (this._isFinalStage(startZ)) activeStages.push('final');
        const pickedStage = activeStages.length
            ? activeStages[Math.floor(Math.random() * activeStages.length)]
            : null;

        // === 後半ステージ専用プロップ（コンセプト画像 m3jxBpfv0qrr 準拠） ===
        if (pickedStage === 'late') {
            // 銅赤ドーム宮殿（巨大ランドマーク）
            if (Math.random() > 0.4) {
                const palace = this._buildCopperPalace(new THREE.Group());
                const side = Math.random() > 0.5 ? 1 : -1;
                palace.position.set(
                    side * (14 + Math.random() * 4),
                    0,
                    startZ + Math.random() * this.chunkSize
                );
                palace.rotation.y = side > 0 ? -Math.PI / 2 + 0.15 : Math.PI / 2 - 0.15;
                palace.scale.setScalar(1.95 + Math.random() * 0.45);
                this.scene.add(palace);
                chunk.objects.push(palace);
                tag(palace, 'block', 7.6);
            }
            // 城壁（連続感を強調する巨大化）
            if (Math.random() > 0.4) {
                const wall = this._buildFortressWall(new THREE.Group());
                const side = Math.random() > 0.5 ? 1 : -1;
                wall.position.set(
                    side * (11 + Math.random() * 3),
                    0,
                    startZ + Math.random() * this.chunkSize
                );
                wall.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
                wall.scale.setScalar(1.75 + Math.random() * 0.35);
                this.scene.add(wall);
                chunk.objects.push(wall);
                tag(wall, 'block', 6.5);
            }
            // 果物屋台（道沿い）
            if (Math.random() > 0.5) {
                const stand = this._buildFruitStand(new THREE.Group());
                const side = Math.random() > 0.5 ? 1 : -1;
                stand.position.set(
                    side * (6 + Math.random() * 1.5),
                    0,
                    startZ + Math.random() * this.chunkSize
                );
                stand.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
                this.scene.add(stand);
                chunk.objects.push(stand);
                tag(stand, 'destructible', 1.4);
            }
            // 後半は土器が増える（市場感）
            if (Math.random() > 0.4) tag(place(this._buildClayPots(new THREE.Group()), 10), 'destructible', 1.1);
            // アフリカ村の小屋は後半では出ない（意図的に）
        }

        // ============================================
        // STREET-SCAPE PROPS（コンセプト QD9QMPq1JWHb / 0bSNIrGdkOIk から抽出）
        // 砲弾で破壊可能・確率でアイテムドロップ
        // ============================================
        const dropCommon = ['score', 'score', 'grenade', 'health', 'power_SPREAD'];
        const dropMilitary = ['grenade', 'grenade', 'health', 'score', 'weapon_H', 'power_BIG'];
        const dropExplosive = ['grenade', 'health', 'score_big', 'weapon_R', 'power_FLAME'];
        const dropTower = ['weapon_H', 'weapon_R', 'weapon_S', 'grenade', 'health', 'power_BIG', 'power_SPREAD', 'power_FLAME'];

        // === 幹線道路脇のショップ（雑貨屋 / 八百屋）===
        // 砲弾を数発当てると爆発して壊せる、ドロップ確率の高いお宝プロップ。
        if (Math.random() > 0.62) {
            const useVeg = Math.random() < 0.5;
            const shop = useVeg
                ? this._buildVegetableShop(new THREE.Group())
                : this._buildGeneralStore(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            shop.position.set(
                side * (6.7 + Math.random() * 1.1),
                0,
                startZ + Math.random() * this.chunkSize
            );
            shop.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
            this.scene.add(shop);
            chunk.objects.push(shop);
            tag(shop, 'destructible', 2.9, 180, {
                explosive: true, explosionVisual: 'large', blastRadius: 3.2,
                dropChance: 0.7,
                dropTable: useVeg ? dropCommon : dropMilitary,
                score: 900,
            });
        }

        // 高床式監視櫓（巨大ランドマーク）
        if (Math.random() > 0.55) {
            const tower = this._buildStiltWatchtower(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            tower.position.set(
                side * (12 + Math.random() * 3),
                0,
                startZ + Math.random() * this.chunkSize
            );
            tower.rotation.y = side > 0 ? -Math.PI / 2 + (Math.random() - 0.5) * 0.4 : Math.PI / 2 + (Math.random() - 0.5) * 0.4;
            tower.scale.setScalar(1.75 + Math.random() * 0.35);
            this.scene.add(tower);
            chunk.objects.push(tower);
            tag(tower, 'destructible', 3.8, 35, {
                explosionVisual: 'large',
                dropChance: 0.6, dropTable: dropTower, score: 1000,
            });
        }

        // 赤いオイルドラム集積（爆発物）— 砂漠基地の象徴的小道具
        if (Math.random() > 0.35) {
            const rack = this._buildOilDrumRack(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            rack.position.set(
                side * (5.5 + Math.random() * 1.8),
                0,
                startZ + Math.random() * this.chunkSize
            );
            rack.rotation.y = (Math.random() - 0.5) * 0.6;
            this.scene.add(rack);
            chunk.objects.push(rack);
            tag(rack, 'destructible', 1.5, 8, {
                explosive: true, explosionVisual: 'mega',
                blastRadius: 5.0,
                dropChance: 0.45, dropTable: dropExplosive, score: 400,
            });
        }

        // スクラップ金属の山（砂漠基地のジャンクヤード感）
        if (Math.random() > 0.4) {
            const pile = this._buildScrapMetalPile(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            pile.position.set(
                side * (6 + Math.random() * 2),
                0,
                startZ + Math.random() * this.chunkSize
            );
            pile.rotation.y = Math.random() * Math.PI * 2;
            this.scene.add(pile);
            chunk.objects.push(pile);
            tag(pile, 'destructible', 1.6, 18, {
                dropChance: 0.35, dropTable: dropCommon, score: 250,
            });
        }

        // 廃棄ジープ（軍用車両）
        if (Math.random() > 0.6) {
            const jeep = this._buildWreckedJeep(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            jeep.position.set(
                side * (5.5 + Math.random() * 2),
                0,
                startZ + Math.random() * this.chunkSize
            );
            jeep.rotation.y = (Math.random() - 0.5) * Math.PI;
            this.scene.add(jeep);
            chunk.objects.push(jeep);
            tag(jeep, 'destructible', 1.6, 25, {
                explosive: true, explosionVisual: 'large',
                blastRadius: 3.5,
                dropChance: 0.55, dropTable: dropMilitary, score: 600,
            });
        }

        // 弾薬箱の山積み
        if (Math.random() > 0.25) {
            const stack = this._buildAmmoCrateStack(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            stack.position.set(
                side * (4.5 + Math.random() * 2),
                0,
                startZ + Math.random() * this.chunkSize
            );
            stack.rotation.y = (Math.random() - 0.5) * 0.8;
            this.scene.add(stack);
            chunk.objects.push(stack);
            tag(stack, 'destructible', 1.0, 12, {
                dropChance: 0.7, dropTable: dropMilitary, score: 300,
            });
        }

        // 軍用標識ポスト
        if (Math.random() > 0.45) {
            const sign = this._buildMilitarySignpost(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            sign.position.set(
                side * (4 + Math.random() * 1.5),
                0,
                startZ + Math.random() * this.chunkSize
            );
            sign.rotation.y = (Math.random() - 0.5) * 0.8;
            this.scene.add(sign);
            chunk.objects.push(sign);
            tag(sign, 'destructible', 0.5, 4, {
                dropChance: 0.15, dropTable: dropCommon, score: 100,
            });
        }

        // 無線アンテナ／無線小屋
        if (Math.random() > 0.6) {
            const antenna = this._buildRadioAntenna(new THREE.Group());
            const side = Math.random() > 0.5 ? 1 : -1;
            antenna.position.set(
                side * (8 + Math.random() * 2),
                0,
                startZ + Math.random() * this.chunkSize
            );
            this.scene.add(antenna);
            chunk.objects.push(antenna);
            tag(antenna, 'destructible', 1.4, 18, {
                explosionVisual: 'large',
                dropChance: 0.4, dropTable: dropMilitary, score: 350,
            });
        }

        // ============================================
        // 後半〜終盤ステージのダイナミックなランドマーク
        // ============================================
        // 動的プロップ用配置ヘルパー（dynamicProps の最終 push を obj.userData にリンク）
        const placeDynamic = (builder, lateralRange, opts = {}) => {
            const beforeLen = this.dynamicProps.length;
            const obj = builder.call(this, new THREE.Group());
            const side = (opts.farSide !== false)
                ? (Math.random() > 0.5 ? 1 : -1)
                : 0;
            const dist = opts.dist !== undefined ? opts.dist : (8 + Math.random() * 2);
            obj.position.set(
                side ? side * dist : (Math.random() - 0.5) * lateralRange * 2,
                0,
                startZ + Math.random() * this.chunkSize
            );
            if (opts.faceRoad && side) {
                obj.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
            } else {
                obj.rotation.y = Math.random() * Math.PI * 2;
            }
            if (opts.scale !== undefined) {
                obj.scale.setScalar(opts.scale);
            }
            this.scene.add(obj);
            chunk.objects.push(obj);
            // 追加した動的参照を obj に紐付け（チャンク削除で arr から外すため）
            if (this.dynamicProps.length > beforeLen) {
                const dyn = this.dynamicProps[this.dynamicProps.length - 1];
                obj.userData.dynamicRef = dyn;
                // 距離カリング用のホスト参照（毎フレ位置比較で遠方更新をスキップ）
                dyn.host = obj;
            }
            return obj;
        };

        // === Mid stage（z > 220）: 軍事工業地帯 ===
        if (pickedStage === 'mid') {
            // 工業煙突（背景・巨大化で迫力）
            if (Math.random() > 0.55) {
                const sm = placeDynamic(this._buildSmokestack, 0, {
                    dist: 14 + Math.random() * 3, faceRoad: true,
                    scale: 1.7 + Math.random() * 0.5,
                });
                tag(sm, 'block', 2.5);
            }
            // ガントリークレーン（道路をまたぐ巨大鉄骨）
            if (Math.random() > 0.65) {
                const cr = placeDynamic(this._buildGantryCrane, 0, {
                    dist: 12 + Math.random() * 2, faceRoad: true,
                    scale: 1.55 + Math.random() * 0.35,
                });
                tag(cr, 'block', 5.0);
            }
            // 蒸気噴出パイプ（道沿い）
            if (Math.random() > 0.4) {
                const sv = placeDynamic(this._buildSteamVent, 0, { dist: 5 + Math.random() * 1.5, faceRoad: true });
                tag(sv, 'destructible', 0.6, 6, {
                    explosionVisual: 'small',
                    dropChance: 0.20, dropTable: dropCommon, score: 150,
                });
            }
        }

        // === Heavy stage（z > 450）: 戦地・廃墟 ===
        if (pickedStage === 'heavy') {
            // 燃える石油櫓（夜空に映える巨大炎柱）
            if (Math.random() > 0.55) {
                const dr = placeDynamic(this._buildBurningDerrick, 0, {
                    dist: 13 + Math.random() * 3, faceRoad: false,
                    scale: 1.55 + Math.random() * 0.4,
                });
                tag(dr, 'block', 3.2);
            }
            // 撃破された Di-Cokka 戦車残骸（道路のすぐ脇）
            if (Math.random() > 0.45) {
                const wk = placeDynamic(this._buildWreckedTank, 0, {
                    dist: 4.5 + Math.random() * 1.5,
                    scale: 1.2 + Math.random() * 0.3,
                });
                tag(wk, 'destructible', 2.2, 10, {
                    explosionVisual: 'large', dropChance: 0.5, dropTable: dropMilitary, score: 700,
                });
            }
            // 対空砲台（道路から離れた位置）
            if (Math.random() > 0.55) {
                const aa = placeDynamic(this._buildAntiAirGun, 0, {
                    dist: 7 + Math.random() * 2, faceRoad: true,
                    scale: 1.3 + Math.random() * 0.3,
                });
                tag(aa, 'destructible', 2.6, 35, {
                    explosionVisual: 'large', explosive: true, blastRadius: 3.0,
                    dropChance: 0.6, dropTable: dropExplosive, score: 900,
                });
            }
            // 崩落高層廃墟（巨大化でスカイラインを支配）
            if (Math.random() > 0.6) {
                const ruin = this._buildCollapsedHighrise(new THREE.Group());
                const side = Math.random() > 0.5 ? 1 : -1;
                ruin.position.set(
                    side * (14 + Math.random() * 3),
                    0,
                    startZ + Math.random() * this.chunkSize
                );
                ruin.rotation.y = side > 0 ? -Math.PI / 2 + (Math.random() - 0.5) * 0.25 : Math.PI / 2 + (Math.random() - 0.5) * 0.25;
                ruin.scale.setScalar(1.55 + Math.random() * 0.4);
                this.scene.add(ruin);
                chunk.objects.push(ruin);
                tag(ruin, 'block', 5.5);
            }
        }

        // === Final stage（z > 680）: 反乱軍要塞 ===
        if (pickedStage === 'final') {
            // 巨大反逆軍旗（要塞の象徴）
            if (Math.random() > 0.55) {
                const bn = placeDynamic(this._buildRebelBanner, 0, { dist: 8 + Math.random() * 2, faceRoad: false });
                tag(bn, 'destructible', 1.0, 6, {
                    dropChance: 0.4, dropTable: dropMilitary, score: 500,
                });
            }
            // サーチライト塔（夜陣地のような演出）
            if (Math.random() > 0.65) {
                const sl = placeDynamic(this._buildSearchlightTower, 0, { dist: 9 + Math.random() * 2, faceRoad: false });
                tag(sl, 'destructible', 1.6, 25, {
                    explosionVisual: 'large', dropChance: 0.5, dropTable: dropTower, score: 900,
                });
            }
            // 古代ピラミッド遺跡（巨大ランドマーク、当たり判定なし背景物）
            if (Math.random() > 0.55) {
                const py = this._buildPyramidRuin(new THREE.Group());
                const side = Math.random() > 0.5 ? 1 : -1;
                py.position.set(side * (17 + Math.random() * 4), 0,
                    startZ + Math.random() * this.chunkSize);
                py.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
                py.scale.setScalar(1.6 + Math.random() * 0.4);
                this.scene.add(py);
                chunk.objects.push(py);
                tag(py, 'block', 7.0);
            }
            // 装甲ゲート（巨大要塞門）
            if (Math.random() > 0.55) {
                const gate = placeDynamic(this._buildFortressGate, 0, {
                    dist: 13 + Math.random() * 3, faceRoad: true,
                    scale: 1.5 + Math.random() * 0.35,
                });
                tag(gate, 'destructible', 4.0, 40, {
                    explosionVisual: 'large', dropChance: 0.55, dropTable: dropTower, score: 1100,
                });
            }
            // レーダードーム（巨大化で回転索敵感を強調）
            if (Math.random() > 0.55) {
                const dome = placeDynamic(this._buildRadarDome, 0, {
                    dist: 16 + Math.random() * 3, faceRoad: false,
                    scale: 1.55 + Math.random() * 0.4,
                });
                tag(dome, 'block', 4.5);
            }
        }

        // === Endgame stage（Wave 13〜22）: 地形・大型物を密に追加 ===
        const endgamePhase = this._getEndgamePhase(startZ);
        if (endgamePhase >= 0) {
            const density = Math.min(0.90, 0.58 + endgamePhase * 0.06);

            // 砲撃跡クレーター帯（荒廃した地形）
            if (Math.random() < density) {
                const crater = this._buildCraterBelt(new THREE.Group(), 2 + endgamePhase);
                place(crater, 7);
                tag(crater, 'block', 2.2 + endgamePhase * 0.25);
            }

            // 塹壕バリケード（道路脇の防衛線）
            if (Math.random() < density) {
                const trench = this._buildTrenchBarricade(new THREE.Group(), endgamePhase);
                const side = Math.random() > 0.5 ? 1 : -1;
                trench.position.set(
                    side * (6.8 + Math.random() * 2.2),
                    0,
                    startZ + Math.random() * this.chunkSize
                );
                trench.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
                this.scene.add(trench);
                chunk.objects.push(trench);
                tag(trench, 'block', 2.8 + endgamePhase * 0.2);
            }

            // 重装バンカー（巨大化で要塞感を強調）
            if (Math.random() < Math.min(0.88, 0.55 + endgamePhase * 0.08)) {
                const bunker = this._buildFortifiedBunker(new THREE.Group());
                const side = Math.random() > 0.5 ? 1 : -1;
                bunker.position.set(
                    side * (11 + Math.random() * 2.5),
                    0,
                    startZ + Math.random() * this.chunkSize
                );
                bunker.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
                bunker.scale.setScalar(1.45 + Math.random() * 0.35);
                this.scene.add(bunker);
                chunk.objects.push(bunker);
                tag(bunker, 'destructible', 4.4, 45, {
                    explosionVisual: 'large',
                    dropChance: 0.55, dropTable: dropTower, score: 1200,
                });
            }

            // 崩落高架（巨大スカイブリッジ風）
            // 道路中央寄り (旧: ±1.75) だと block 半径 (≈6.1〜8.5) が
            // プレイヤー横移動範囲 ±8 を超えて道を完全に塞ぐため、必ず片側に寄せ
            // phase に応じて反対側に通行帯を確保する。
            if (endgamePhase >= 1 && Math.random() < Math.min(0.9, 0.6 + endgamePhase * 0.06)) {
                const overpass = this._buildBrokenOverpass(new THREE.Group(), endgamePhase);
                const overpassSide = Math.random() > 0.5 ? 1 : -1;
                const overpassOffset = 2.6 + Math.random() * 1.4 + endgamePhase * 0.18;
                overpass.position.set(
                    overpassSide * overpassOffset,
                    0,
                    startZ + Math.random() * this.chunkSize
                );
                overpass.rotation.y = (Math.random() - 0.5) * 0.35;
                overpass.scale.setScalar(1.35 + Math.random() * 0.3);
                this.scene.add(overpass);
                chunk.objects.push(overpass);
                tag(overpass, 'block', 5.8 + endgamePhase * 0.3);
            }

            // 警報サイレン塔（Wave 15+）
            if (endgamePhase >= 2 && Math.random() < Math.min(0.82, 0.5 + endgamePhase * 0.04)) {
                const siren = placeDynamic(this._buildSirenMast, 0, {
                    dist: 10 + Math.random() * 3,
                    faceRoad: false,
                });
                tag(siren, 'destructible', 1.5, 20, {
                    explosionVisual: 'large',
                    dropChance: 0.5, dropTable: dropMilitary, score: 800,
                });
            }

            // Wave16〜17 は追加で巨大廃墟を高頻度化
            if (endgamePhase >= 3 && Math.random() < 0.7) {
                const ruin2 = this._buildCollapsedHighrise(new THREE.Group());
                const side = Math.random() > 0.5 ? 1 : -1;
                ruin2.position.set(
                    side * (15 + Math.random() * 2.5),
                    0,
                    startZ + Math.random() * this.chunkSize
                );
                ruin2.rotation.y = side > 0 ? -Math.PI / 2 + (Math.random() - 0.5) * 0.18 : Math.PI / 2 + (Math.random() - 0.5) * 0.18;
                ruin2.scale.setScalar(1.6 + Math.random() * 0.4);
                this.scene.add(ruin2);
                chunk.objects.push(ruin2);
                tag(ruin2, 'block', 6.5);
            }

            // Wave18+ 深部要塞: 工場・発射施設・エネルギー設備を追加
            if (endgamePhase >= 5) {
                const deepDensity = Math.min(0.78, 0.38 + (endgamePhase - 5) * 0.08);

                if (Math.random() < deepDensity) {
                    const factory = this._buildWarFactoryFacade(new THREE.Group(), endgamePhase);
                    const side = Math.random() > 0.5 ? 1 : -1;
                    factory.position.set(
                        side * (16 + Math.random() * 3.5),
                        0,
                        startZ + Math.random() * this.chunkSize
                    );
                    factory.rotation.y = side > 0 ? -Math.PI / 2 + (Math.random() - 0.5) * 0.16 : Math.PI / 2 + (Math.random() - 0.5) * 0.16;
                    factory.scale.setScalar(1.5 + Math.random() * 0.4);
                    this.scene.add(factory);
                    chunk.objects.push(factory);
                    tag(factory, 'block', 7.5);
                }

                if (Math.random() < deepDensity * 0.75) {
                    const rail = this._buildRailYardBarricade(new THREE.Group(), endgamePhase);
                    rail.position.set(
                        (Math.random() - 0.5) * 5.5,
                        0,
                        startZ + Math.random() * this.chunkSize
                    );
                    rail.rotation.y = (Math.random() - 0.5) * 0.35;
                    this.scene.add(rail);
                    chunk.objects.push(rail);
                    tag(rail, 'block', 3.8 + endgamePhase * 0.08);
                }

                if (Math.random() < deepDensity * 0.62) {
                    const cannon = placeDynamic(this._buildMegaCannonEmplacement, 0, {
                        dist: 11 + Math.random() * 3,
                        faceRoad: true,
                    });
                    tag(cannon, 'destructible', 2.6, 55, {
                        explosive: true, explosionVisual: 'mega',
                        blastRadius: 4.5, dropChance: 0.65, dropTable: dropExplosive, score: 1500,
                    });
                }

                if (Math.random() < deepDensity * 0.58) {
                    const gen = placeDynamic(this._buildShieldGenerator, 0, {
                        dist: 12 + Math.random() * 3.5,
                        faceRoad: false,
                    });
                    tag(gen, 'destructible', 2.2, 42, {
                        explosionVisual: 'large',
                        dropChance: 0.6, dropTable: dropTower, score: 1300,
                    });
                }

                if (endgamePhase >= 7 && Math.random() < deepDensity * 0.56) {
                    const silo = placeDynamic(this._buildMissileSiloCluster, 0, {
                        dist: 13 + Math.random() * 3,
                        faceRoad: false,
                    });
                    tag(silo, 'destructible', 2.8, 48, {
                        explosive: true, explosionVisual: 'mega',
                        blastRadius: 4.2, dropChance: 0.65, dropTable: dropExplosive, score: 1600,
                    });
                }
            }
        }

        this._applyChunkPerformanceHints(chunk, startZ);
        this._trimChunkForPerformance(chunk, startZ);

        this.chunks.push(chunk);
        this.lastChunkZ = startZ;
        this._obstacleCacheDirty = true;
    }

    _isPerformanceChunk(z) {
        return this._isFinalStage(z) || this._getEndgamePhase(z) >= 0;
    }

    _getChunkObjectBudget(z) {
        const phase = this._getEndgamePhase(z);
        if (phase >= 5) return 20;
        if (phase >= 0) return 23;
        if (this._isFinalStage(z)) return 26;
        if (this._isHeavyStage(z)) return 34;
        return 42;
    }

    _applyChunkPerformanceHints(chunk, z) {
        const isPerfChunk = this._isPerformanceChunk(z);
        // Wave 8 相当（z > 450）以降は shadow caster の高さしきい値を 3 → 1.5 に下げ、
        // 低めの障害物（バリケード・木箱・小物）も shadow パスから外す。
        // Wave 16+ の同時敵密度では shadow pass が支配的になるため、世界側を先に絞る。
        const heavyShadowCull = this._isHeavyStage(z);
        const shadowYThreshold = heavyShadowCull ? 1.5 : 3;
        for (const obj of chunk.objects) {
            obj.traverse(child => {
                if (!child.isMesh) return;
                if (isPerfChunk) {
                    child.castShadow = false;
                    child.receiveShadow = false;
                } else if (child.castShadow && child.position.y > shadowYThreshold) {
                    child.castShadow = false;
                }
            });
            // 静的プロップの matrixAutoUpdate を切って毎フレの行列再計算を省略する。
            // 動的プロップ (炎/旗/サーチライト等) は子 mesh の transform をアニメするため
            // root だけ凍結し、子は通常通り auto-update させる。
            // 障害物が破壊された時は destroyObstacle が scene.remove するので問題ない。
            const isDynamic = obj.userData && obj.userData.dynamicRef;
            obj.updateMatrix();
            obj.matrixAutoUpdate = false;
            if (!isDynamic) {
                obj.traverse(child => {
                    if (child === obj) return;
                    child.updateMatrix();
                    child.matrixAutoUpdate = false;
                });
            }
        }
    }

    _getTrimPriority(obj) {
        const info = obj.userData && obj.userData.obstacle;
        if (!info) return 100;
        if (info.type === 'block' || info.explosive) return 0;
        if (info.radius <= 1.5 && info.hp <= 20) return 70;
        if (info.radius <= 2.2 && info.hp <= 25) return 45;
        if (!info.dropTable && info.dropChance <= 0.25) return 35;
        return 12;
    }

    _trimChunkForPerformance(chunk, z) {
        const budget = this._getChunkObjectBudget(z);
        if (chunk.objects.length <= budget) return;

        const candidates = chunk.objects
            .map((obj, idx) => ({ obj, idx, priority: this._getTrimPriority(obj) }))
            .filter(entry => entry.priority > 0)
            .sort((a, b) => b.priority - a.priority || a.idx - b.idx);

        while (chunk.objects.length > budget && candidates.length > 0) {
            const entry = candidates.shift();
            const idx = chunk.objects.indexOf(entry.obj);
            if (idx === -1) continue;
            chunk.objects.splice(idx, 1);
            this._disposeChunkObject(entry.obj);
        }
    }

    _disposeChunkObject(obj) {
        this.scene.remove(obj);
        obj.traverse(child => {
            if (child.userData && child.userData.dynamicRef) {
                const idx = this.dynamicProps.indexOf(child.userData.dynamicRef);
                if (idx >= 0) this.dynamicProps.splice(idx, 1);
            }
            if (!child.isMesh) return;
            const g = child.geometry;
            if (g && g.dispose && !(g.userData && g.userData.shared)) g.dispose();
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(mat => {
                if (!mat) return;
                if (mat.userData && mat.userData.shared) return;
                if (mat.map && mat.map.dispose && !(mat.map.userData && mat.map.userData.shared)) mat.map.dispose();
                if (mat.dispose) mat.dispose();
            });
        });
    }

    /**
     * 障害物のリストを返す（戦車との衝突判定用）。
     * 後半は毎フレーム数百件ループされるため、配列とエントリを再利用する。
     * チャンク追加/削除・破壊時に dirty にして再構築。
     * @returns {{obj: THREE.Object3D, info: {type:'block'|'destructible', radius:number, hp:number, destroyed:boolean}}[]}
     */
    getObstacles() {
        if (!this._obstacleCacheDirty) return this._obstacleCache;
        const cache = this._obstacleCache;
        cache.length = 0;
        for (const chunk of this.chunks) {
            for (const obj of chunk.objects) {
                const info = obj.userData.obstacle;
                if (info && !info.destroyed) {
                    cache.push({ obj, info });
                }
            }
        }
        this._obstacleCacheDirty = false;
        return cache;
    }

    /**
     * 障害物を破壊（チャンクから除去・リソース解放）
     * @param {THREE.Object3D} obj
     */
    destroyObstacle(obj) {
        const info = obj.userData.obstacle;
        if (!info || info.destroyed) return;
        info.destroyed = true;
        this.scene.remove(obj);
        // dynamicProps からも除去（解放済 mesh を update() が触らないように）
        obj.traverse(child => {
            if (child.userData && child.userData.dynamicRef) {
                const idx = this.dynamicProps.indexOf(child.userData.dynamicRef);
                if (idx >= 0) this.dynamicProps.splice(idx, 1);
            }
            if (child.isMesh) {
                const g = child.geometry;
                if (g && g.dispose && !(g.userData && g.userData.shared)) g.dispose();
                const mat = child.material;
                if (mat && mat.dispose && !(mat.userData && mat.userData.shared)) mat.dispose();
            }
        });
        for (const chunk of this.chunks) {
            const idx = chunk.objects.indexOf(obj);
            if (idx !== -1) {
                chunk.objects.splice(idx, 1);
                this._obstacleCacheDirty = true;
                return;
            }
        }
        this._obstacleCacheDirty = true;
    }

    _buildDesertShrubs() {
        const group = new THREE.Group();
        const stemMat = new THREE.MeshStandardMaterial({ color: 0x64562E, roughness: 0.9 });
        const leafMat = new THREE.MeshStandardMaterial({ color: 0x7C8A42, roughness: 0.88 });
        const bushCount = 2 + Math.floor(Math.random() * 4);
        for (let i = 0; i < bushCount; i++) {
            const rootX = (Math.random() - 0.5) * 2.8;
            const rootZ = (Math.random() - 0.5) * 1.6;
            for (let b = 0; b < 4; b++) {
                const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.3 + Math.random() * 0.25, 5), stemMat);
                stem.position.set(rootX + (Math.random() - 0.5) * 0.2, 0.12, rootZ + (Math.random() - 0.5) * 0.2);
                stem.rotation.z = (Math.random() - 0.5) * 0.9;
                group.add(stem);
            }
            for (let l = 0; l < 7; l++) {
                const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.08 + Math.random() * 0.07, 4, 3), leafMat);
                leaf.position.set(
                    rootX + (Math.random() - 0.5) * 0.35,
                    0.22 + Math.random() * 0.25,
                    rootZ + (Math.random() - 0.5) * 0.35
                );
                leaf.scale.y = 0.55;
                group.add(leaf);
            }
        }
        return group;
    }

    _buildTornBannerPost() {
        const group = new THREE.Group();
        const postMat = new THREE.MeshStandardMaterial({ color: 0x6B5539, roughness: 0.86 });
        const clothMat = new THREE.MeshStandardMaterial({
            color: Math.random() > 0.5 ? 0xAA2E1F : 0x2D4F7A,
            roughness: 0.92,
            side: THREE.DoubleSide,
        });
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 3.2, 6), postMat);
        post.position.y = 1.6;
        post.rotation.z = (Math.random() - 0.5) * 0.15;
        group.add(post);

        for (let i = 0; i < 3; i++) {
            const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.5 + i * 0.18, 0.2 + i * 0.04), clothMat);
            cloth.position.set(0.16 + i * 0.2, 2.6 - i * 0.35, 0);
            cloth.rotation.y = Math.PI / 2;
            cloth.rotation.z = -0.08 - i * 0.12;
            group.add(cloth);
        }

        const baseStone = new THREE.Mesh(
            new THREE.CylinderGeometry(0.24, 0.3, 0.2, 8),
            new THREE.MeshStandardMaterial({ color: 0x8A7355, roughness: 0.95 })
        );
        baseStone.position.y = 0.1;
        group.add(baseStone);
        return group;
    }

    _buildRuinPillar() {
        const group = new THREE.Group();
        const stone = new THREE.MeshStandardMaterial({ color: 0xB79A72, roughness: 0.95, flatShading: true });
        const dark = new THREE.MeshStandardMaterial({ color: 0x8A7154, roughness: 0.96, flatShading: true });

        const h = 2.4 + Math.random() * 1.8;
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.3, h, 7), stone);
        shaft.position.y = h / 2;
        shaft.rotation.z = (Math.random() - 0.5) * 0.18;
        group.add(shaft);

        const cap = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.22, 0.7), dark);
        cap.position.y = h + 0.08;
        group.add(cap);

        for (let i = 0; i < 6; i++) {
            const chip = new THREE.Mesh(new THREE.DodecahedronGeometry(0.09 + Math.random() * 0.12, 0), i % 2 ? stone : dark);
            chip.position.set((Math.random() - 0.5) * 1.2, 0.06 + Math.random() * 0.2, (Math.random() - 0.5) * 1.1);
            group.add(chip);
        }
        return group;
    }

    _buildCaravanCart() {
        const group = new THREE.Group();
        const wood = new THREE.MeshStandardMaterial({ color: 0x7A5530, roughness: 0.88 });
        const metal = new THREE.MeshStandardMaterial({ color: 0x4A4A45, roughness: 0.55, metalness: 0.45 });
        const cloth = new THREE.MeshStandardMaterial({ color: 0xB78D4A, roughness: 0.92 });

        const bed = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.2, 1.2), wood);
        bed.position.y = 0.65;
        group.add(bed);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.25, 0.08), wood);
        rail.position.set(0, 0.82, 0.56);
        group.add(rail);
        const rail2 = rail.clone();
        rail2.position.z = -0.56;
        group.add(rail2);

        for (const x of [-0.85, 0.85]) {
            const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.08, 6, 12), metal);
            wheel.position.set(x, 0.4, 0.74);
            wheel.rotation.y = Math.PI / 2;
            group.add(wheel);
            const wheel2 = wheel.clone();
            wheel2.position.z = -0.74;
            group.add(wheel2);
        }

        const canopy = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 1.7, 10, 1, true, 0, Math.PI), cloth);
        canopy.rotation.z = Math.PI / 2;
        canopy.position.set(0, 1.28, 0);
        group.add(canopy);

        for (let i = 0; i < 4; i++) {
            const sack = new THREE.Mesh(
                new THREE.SphereGeometry(0.17 + Math.random() * 0.06, 6, 4),
                new THREE.MeshStandardMaterial({ color: 0x9A7B4E, roughness: 0.9 })
            );
            sack.position.set((Math.random() - 0.5) * 1.2, 0.86 + Math.random() * 0.15, (Math.random() - 0.5) * 0.6);
            sack.scale.y = 0.7;
            group.add(sack);
        }
        return group;
    }

    /* --- サボテン（Metal Slug風砂漠のアクセント） --- */
    _buildCactus() {
        const group = new THREE.Group();
        const cactusMat = new THREE.MeshStandardMaterial({
            color: 0x4B6B3A, roughness: 0.85,
        });
        const darkMat = new THREE.MeshStandardMaterial({
            color: 0x2E4522, roughness: 0.9,
        });

        // 本体
        const h = 1.8 + Math.random() * 1.2;
        const trunk = new THREE.Mesh(
            new THREE.CylinderGeometry(0.22, 0.26, h, 8),
            cactusMat
        );
        trunk.position.y = h / 2;
        trunk.castShadow = true;
        group.add(trunk);

        // 腕（左右）
        if (Math.random() > 0.3) {
            for (const side of [-1, 1]) {
                if (Math.random() > 0.3) {
                    const armH = 0.7 + Math.random() * 0.5;
                    const arm = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.13, 0.16, armH, 8),
                        cactusMat
                    );
                    arm.position.set(side * 0.28, h * 0.6 + armH / 2, 0);
                    group.add(arm);
                    // 水平部分
                    const horiz = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.14, 0.16, 0.4, 8),
                        cactusMat
                    );
                    horiz.position.set(side * 0.15, h * 0.6, 0);
                    horiz.rotation.z = Math.PI / 2;
                    group.add(horiz);
                }
            }
        }

        // トゲ（小さな白い点）
        const spineMat = new THREE.MeshBasicMaterial({ color: 0xFFFFDD });
        for (let i = 0; i < 20; i++) {
            const spine = new THREE.Mesh(
                new THREE.SphereGeometry(0.015, 3, 2),
                spineMat
            );
            const a = Math.random() * Math.PI * 2;
            spine.position.set(
                Math.cos(a) * 0.24,
                0.2 + Math.random() * (h - 0.2),
                Math.sin(a) * 0.24
            );
            group.add(spine);
        }
        // 縦の溝の陰影
        for (let i = 0; i < 4; i++) {
            const stripe = new THREE.Mesh(
                new THREE.BoxGeometry(0.02, h - 0.2, 0.02),
                darkMat
            );
            const a = (i / 4) * Math.PI * 2;
            stripe.position.set(Math.cos(a) * 0.23, h / 2, Math.sin(a) * 0.23);
            group.add(stripe);
        }
        return group;
    }

    /* --- 岩の塊 --- */
    _buildRockCluster() {
        const group = new THREE.Group();
        const rockMat = new THREE.MeshStandardMaterial({
            color: 0x8B6E4A, roughness: 0.98, flatShading: true,
        });
        const darkRockMat = new THREE.MeshStandardMaterial({
            color: 0x6B4E30, roughness: 0.98, flatShading: true,
        });
        const count = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < count; i++) {
            const size = 0.3 + Math.random() * 0.8;
            const geo = new THREE.DodecahedronGeometry(size, 0);
            const rock = new THREE.Mesh(geo, i % 2 === 0 ? rockMat : darkRockMat);
            rock.position.set(
                (Math.random() - 0.5) * 2.5,
                size * 0.5,
                (Math.random() - 0.5) * 1.5
            );
            rock.rotation.set(Math.random(), Math.random(), Math.random());
            rock.castShadow = true;
            group.add(rock);
        }
        return group;
    }

    /* --- 砂山（小さな砂丘） --- */
    _buildSandPile() {
        const group = new THREE.Group();
        const sandMat = new THREE.MeshStandardMaterial({
            color: 0xD4A870, roughness: 0.98, flatShading: true,
        });
        // 円錐形の砂山
        const pile = new THREE.Mesh(
            new THREE.ConeGeometry(1.2 + Math.random() * 0.6, 0.5 + Math.random() * 0.4, 8),
            sandMat
        );
        pile.position.y = 0.25;
        pile.scale.set(1, 0.7, 0.9);
        group.add(pile);

        // 小さな石（ちらばり）
        const stoneMat = new THREE.MeshStandardMaterial({ color: 0x7B5A3A, roughness: 0.95 });
        for (let i = 0; i < 4; i++) {
            const stone = new THREE.Mesh(
                new THREE.DodecahedronGeometry(0.08 + Math.random() * 0.1, 0),
                stoneMat
            );
            stone.position.set(
                (Math.random() - 0.5) * 2,
                0.08,
                (Math.random() - 0.5) * 1.5
            );
            group.add(stone);
        }
        return group;
    }

    /* --- 動物の骨/ドクロ --- */
    _buildSkullBones() {
        const group = new THREE.Group();
        const boneMat = new THREE.MeshStandardMaterial({
            color: 0xE8D8B8, roughness: 0.85,
        });

        // 頭蓋骨（角付き）
        const skull = new THREE.Mesh(
            new THREE.SphereGeometry(0.25, 8, 6),
            boneMat
        );
        skull.scale.set(1.2, 0.9, 0.9);
        skull.position.y = 0.2;
        skull.rotation.y = (Math.random() - 0.5) * 0.5;
        group.add(skull);

        // 目の穴
        for (const zOff of [-0.09, 0.09]) {
            const eye = new THREE.Mesh(
                new THREE.SphereGeometry(0.05, 6, 4),
                new THREE.MeshBasicMaterial({ color: 0x1A1008 })
            );
            eye.position.set(0.18, 0.22, zOff);
            group.add(eye);
        }

        // 角（水牛風）
        for (const side of [-1, 1]) {
            const horn = new THREE.Mesh(
                new THREE.CylinderGeometry(0.03, 0.06, 0.5, 6),
                boneMat
            );
            horn.position.set(0, 0.38, side * 0.15);
            horn.rotation.z = Math.PI / 2 - 0.3;
            horn.rotation.x = side * 0.4;
            group.add(horn);
        }

        // 肋骨（数本）
        for (let i = 0; i < 4; i++) {
            const rib = new THREE.Mesh(
                new THREE.TorusGeometry(0.12 + i * 0.04, 0.015, 4, 8, Math.PI),
                boneMat
            );
            rib.position.set(-0.5 - i * 0.15, 0.05, 0);
            rib.rotation.z = Math.PI;
            group.add(rib);
        }

        // 脊椎
        const spine = new THREE.Mesh(
            new THREE.CylinderGeometry(0.025, 0.025, 0.9, 6),
            boneMat
        );
        spine.position.set(-0.5, 0.05, 0);
        spine.rotation.z = Math.PI / 2;
        group.add(spine);

        return group;
    }

    _buildSandbags() {
        const group = new THREE.Group();
        const bagMat = _sharedMat('sandbag', () => new THREE.MeshStandardMaterial({ color: 0xAA9966, roughness: 0.95 }));
        const rows = 2 + Math.floor(Math.random() * 2);
        for (let row = 0; row < rows; row++) {
            const bagsInRow = 3 - row;
            for (let i = 0; i < bagsInRow; i++) {
                const bag = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.35, 0.5), bagMat);
                bag.position.set((i - (bagsInRow - 1) / 2) * 0.85, row * 0.35 + 0.175, 0);
                bag.rotation.y = (Math.random() - 0.5) * 0.1;
                group.add(bag);
            }
        }
        return group;
    }

    _buildCrates() {
        const group = new THREE.Group();
        const crateMat  = _sharedMat('crate_body',   () => new THREE.MeshStandardMaterial({ color: 0x8B6B3B, roughness: 0.85 }));
        const stripeMat = _sharedMat('crate_stripe', () => new THREE.MeshStandardMaterial({ color: 0x6B5B3B, roughness: 0.9 }));
        const starMat   = _sharedMat('crate_star',   () => new THREE.MeshStandardMaterial({ color: 0xDDDD88, side: THREE.DoubleSide }));
        const count = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < count; i++) {
            const size = 0.6 + Math.random() * 0.4;
            const crate = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), crateMat);
            crate.position.set((Math.random() - 0.5) * 2, size / 2, (Math.random() - 0.5) * 1);
            crate.rotation.y = Math.random() * 0.5;
            crate.castShadow = true;
            group.add(crate);

            const stripe = new THREE.Mesh(new THREE.BoxGeometry(size + 0.02, 0.05, size + 0.02), stripeMat);
            stripe.position.copy(crate.position);
            stripe.position.y += size * 0.2;
            stripe.rotation.y = crate.rotation.y;
            group.add(stripe);
        }

        // 軍用マーキング（星マーク）
        if (Math.random() > 0.5) {
            const star = new THREE.Mesh(new THREE.CircleGeometry(0.15, 5), starMat);
            star.position.set(0, 0.5, 0.52);
            group.add(star);
        }
        return group;
    }

    _buildBarrels() {
        const group = new THREE.Group();
        const redBody    = _sharedMat('barrel_red_body',    () => new THREE.MeshStandardMaterial({ color: 0xAA3333, roughness: 0.6, metalness: 0.3 }));
        const greenBody  = _sharedMat('barrel_green_body',  () => new THREE.MeshStandardMaterial({ color: 0x556655, roughness: 0.6, metalness: 0.3 }));
        const redLabel   = _sharedMat('barrel_red_label',   () => new THREE.MeshStandardMaterial({ color: 0xDD5555, roughness: 0.5 }));
        const greenLabel = _sharedMat('barrel_green_label', () => new THREE.MeshStandardMaterial({ color: 0x667766, roughness: 0.5 }));
        const count = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < count; i++) {
            const isRed = Math.random() > 0.5;
            const barrel = new THREE.Mesh(
                new THREE.CylinderGeometry(0.35, 0.35, 0.9, 10),
                isRed ? redBody : greenBody,
            );
            barrel.position.set((Math.random() - 0.5) * 1.5, 0.45, (Math.random() - 0.5) * 1);
            if (Math.random() > 0.7) {
                barrel.rotation.z = Math.PI / 2;
                barrel.position.y = 0.35;
            }
            barrel.castShadow = true;
            group.add(barrel);

            // ラベル/ストライプ
            const label = new THREE.Mesh(
                new THREE.CylinderGeometry(0.36, 0.36, 0.15, 10),
                isRed ? redLabel : greenLabel,
            );
            label.position.copy(barrel.position);
            label.rotation.copy(barrel.rotation);
            group.add(label);
        }
        return group;
    }

    _buildBarbedWire() {
        const group = new THREE.Group();
        const postMat = _sharedMat('barbed_post', () => new THREE.MeshStandardMaterial({ color: 0x5A5A5A, roughness: 0.6, metalness: 0.4 }));
        const wireMat = _sharedMat('barbed_wire', () => new THREE.MeshBasicMaterial({ color: 0x888888 }));
        for (let i = 0; i < 3; i++) {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.5, 4), postMat);
            post.position.set(i * 1.5, 0.75, 0);
            group.add(post);
        }
        for (let h = 0.5; h <= 1.3; h += 0.4) {
            const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 3, 4), wireMat);
            wire.rotation.z = Math.PI / 2;
            wire.position.set(1.5, h, 0);
            group.add(wire);
        }
        return group;
    }

    _buildTent() {
        const group = new THREE.Group();
        const clothMain = _sharedMat('tent_cloth_main', () => new THREE.MeshStandardMaterial({
            color: 0x6C7B4A, roughness: 0.92, side: THREE.DoubleSide,
        }));
        const clothShade = _sharedMat('tent_cloth_shade', () => new THREE.MeshStandardMaterial({
            color: 0x4E5A36, roughness: 0.95, side: THREE.DoubleSide,
        }));
        const groundSheetMat = _sharedMat('tent_groundsheet', () => new THREE.MeshStandardMaterial({
            color: 0x3F4A34, roughness: 0.95, side: THREE.DoubleSide,
        }));
        const poleMat = _sharedMat('tent_pole', () => new THREE.MeshStandardMaterial({ color: 0x5A4A3A, roughness: 0.8 }));
        const ropeMat = _sharedMat('tent_rope', () => new THREE.MeshBasicMaterial({ color: 0x8E846A }));
        const pegMat = _sharedMat('tent_peg', () => new THREE.MeshStandardMaterial({ color: 0x4A3828, roughness: 0.9 }));
        const openingMat = _sharedMat('tent_opening', () => new THREE.MeshBasicMaterial({ color: 0x1B1712, side: THREE.DoubleSide }));

        const width = 2.6 + Math.random() * 0.7;
        const length = 2.7 + Math.random() * 0.9;
        const height = 1.55 + Math.random() * 0.35;
        const halfW = width * 0.5;
        const halfL = length * 0.5;
        const slopeLen = Math.hypot(halfW, height);
        const tilt = Math.atan2(halfW, height);

        // 下に敷くグラウンドシート
        const groundSheet = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.92, length * 0.88), groundSheetMat);
        groundSheet.rotation.x = -Math.PI / 2;
        groundSheet.position.y = 0.03;
        group.add(groundSheet);

        // 屋根布（左右2面）
        const panelGeo = new THREE.BoxGeometry(0.08, slopeLen, length);
        const leftPanel = new THREE.Mesh(panelGeo, clothMain);
        leftPanel.position.set(-halfW * 0.5, height * 0.5, 0);
        leftPanel.rotation.z = -tilt;
        leftPanel.castShadow = true;
        group.add(leftPanel);

        const rightPanel = new THREE.Mesh(panelGeo, clothShade);
        rightPanel.position.set(halfW * 0.5, height * 0.5, 0);
        rightPanel.rotation.z = tilt;
        rightPanel.castShadow = true;
        group.add(rightPanel);

        // 前後の三角エンド
        const endShape = new THREE.Shape();
        endShape.moveTo(-halfW, 0);
        endShape.lineTo(0, height);
        endShape.lineTo(halfW, 0);
        endShape.lineTo(-halfW, 0);
        const endGeo = new THREE.ShapeGeometry(endShape);

        const frontEnd = new THREE.Mesh(endGeo, clothMain);
        frontEnd.position.z = -halfL;
        group.add(frontEnd);

        const backEnd = new THREE.Mesh(endGeo, clothShade);
        backEnd.position.z = halfL;
        backEnd.rotation.y = Math.PI;
        group.add(backEnd);

        // 入口（暗い開口）とフラップ
        const openingShape = new THREE.Shape();
        openingShape.moveTo(-halfW * 0.32, 0);
        openingShape.lineTo(0, height * 0.62);
        openingShape.lineTo(halfW * 0.32, 0);
        openingShape.lineTo(-halfW * 0.32, 0);
        const opening = new THREE.Mesh(new THREE.ShapeGeometry(openingShape), openingMat);
        opening.position.set(0, 0.02, -halfL - 0.01);
        group.add(opening);

        const flapGeo = new THREE.PlaneGeometry(0.52, height * 0.72);
        const leftFlap = new THREE.Mesh(flapGeo, clothShade);
        leftFlap.position.set(-0.18, height * 0.36, -halfL - 0.02);
        leftFlap.rotation.y = 0.45;
        leftFlap.rotation.z = -0.08;
        group.add(leftFlap);

        const rightFlap = new THREE.Mesh(flapGeo, clothShade);
        rightFlap.position.set(0.18, height * 0.36, -halfL - 0.02);
        rightFlap.rotation.y = -0.45;
        rightFlap.rotation.z = 0.08;
        group.add(rightFlap);

        // 棟木ポール + 前後支柱
        const ridgePole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, length, 6), poleMat);
        ridgePole.rotation.x = Math.PI / 2;
        ridgePole.position.y = height + 0.03;
        group.add(ridgePole);

        for (const z of [-halfL + 0.05, halfL - 0.05]) {
            const support = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, height, 5), poleMat);
            support.position.set(0, height * 0.5, z);
            group.add(support);
        }

        // ガイロープ + ペグ
        const addRope = (sx, sy, sz, ex, ey, ez) => {
            const dir = new THREE.Vector3(ex - sx, ey - sy, ez - sz);
            const len = dir.length();
            const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, len, 5), ropeMat);
            rope.position.set((sx + ex) * 0.5, (sy + ey) * 0.5, (sz + ez) * 0.5);
            rope.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
            group.add(rope);
            const peg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.2, 0.05), pegMat);
            peg.position.set(ex, 0.1, ez);
            peg.rotation.z = (Math.random() - 0.5) * 0.25;
            group.add(peg);
        };
        addRope(-0.12, height * 0.9, -halfL + 0.08, -halfW - 0.5, 0.08, -halfL - 0.15);
        addRope(0.12, height * 0.9, -halfL + 0.08, halfW + 0.5, 0.08, -halfL - 0.15);
        addRope(-0.12, height * 0.9, halfL - 0.08, -halfW - 0.5, 0.08, halfL + 0.15);
        addRope(0.12, height * 0.9, halfL - 0.08, halfW + 0.5, 0.08, halfL + 0.15);

        // 補強パッチ（布の縫い目っぽさ）
        for (const z of [-halfL * 0.45, 0, halfL * 0.45]) {
            const patch = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 0.28), clothShade);
            patch.position.set(0.02, height * 0.78, z);
            patch.rotation.z = 0.08;
            group.add(patch);
        }

        return group;
    }

    _buildBrokenWall() {
        const group = new THREE.Group();
        const blockMat = _sharedMat('block_wall_main', () => new THREE.MeshStandardMaterial({
            color: 0x927B5A, roughness: 0.96,
        }));
        const mortarMat = _sharedMat('block_wall_mortar', () => new THREE.MeshStandardMaterial({
            color: 0x675A49, roughness: 0.98,
        }));
        const capMat = _sharedMat('block_wall_cap', () => new THREE.MeshStandardMaterial({
            color: 0xB09A75, roughness: 0.9,
        }));

        const cols = 7 + Math.floor(Math.random() * 3); // 7〜9個/段
        const rows = 3 + Math.floor(Math.random() * 2); // 3〜4段
        const blockW = 0.34 + Math.random() * 0.05;
        const blockH = 0.2 + Math.random() * 0.03;
        const blockD = 0.26;
        const joint = 0.018;
        const width = cols * blockW + (cols - 1) * joint;
        const height = rows * blockH + (rows - 1) * joint;
        const baseH = 0.28;

        // モルタル下地 + 基礎
        const backPlate = new THREE.Mesh(
            new THREE.BoxGeometry(width + 0.12, height + 0.05, blockD - 0.06),
            mortarMat
        );
        backPlate.position.set(0, baseH + (height + 0.05) * 0.5, -0.01);
        group.add(backPlate);

        const base = new THREE.Mesh(new THREE.BoxGeometry(width + 0.32, baseH, blockD + 0.14), mortarMat);
        base.position.y = baseH * 0.5;
        group.add(base);

        // 積みブロック（千鳥配置）
        const missingChance = 0.08 + Math.random() * 0.07;
        for (let r = 0; r < rows; r++) {
            const rowOffset = (r % 2) * (blockW + joint) * 0.5;
            const y = baseH + blockH * 0.5 + r * (blockH + joint);
            for (let c = 0; c < cols; c++) {
                const x = -width * 0.5 + blockW * 0.5 + c * (blockW + joint) + rowOffset;
                if (x > width * 0.5 - blockW * 0.45) continue;
                if (r > 0 && r < rows - 1 && Math.random() < missingChance) continue;

                const bw = blockW * (0.92 + Math.random() * 0.14);
                const bh = blockH * (0.9 + Math.random() * 0.14);
                const block = new THREE.Mesh(
                    new THREE.BoxGeometry(bw, bh, blockD),
                    Math.random() < 0.16 ? capMat : blockMat
                );
                block.position.set(
                    x + (Math.random() - 0.5) * 0.02,
                    y + (Math.random() - 0.5) * 0.01,
                    0.01 + (Math.random() - 0.5) * 0.015
                );
                block.rotation.y = (Math.random() - 0.5) * 0.02;
                group.add(block);
            }
        }

        // 上部笠木
        const coping = new THREE.Mesh(
            new THREE.BoxGeometry(width + 0.26, 0.12, blockD + 0.12),
            capMat
        );
        coping.position.set(0, baseH + height + 0.08, 0.01);
        group.add(coping);

        // 端部の控え壁
        for (const side of [-1, 1]) {
            const buttress = new THREE.Mesh(
                new THREE.BoxGeometry(0.24, height * 0.78, blockD + 0.18),
                mortarMat
            );
            buttress.position.set(side * (width * 0.5 + 0.06), baseH + height * 0.39, 0);
            group.add(buttress);
        }

        // 破損片（少量）で「壊れた塀」感は維持
        for (let d = 0; d < 2; d++) {
            const debSize = 0.16 + Math.random() * 0.2;
            const deb = new THREE.Mesh(
                new THREE.BoxGeometry(debSize, debSize, debSize),
                blockMat
            );
            deb.position.set(
                -width * 0.35 + Math.random() * width * 0.7,
                0.05 + Math.random() * 0.2,
                (Math.random() - 0.5) * 0.35
            );
            deb.rotation.set(Math.random(), Math.random(), Math.random());
            group.add(deb);
        }

        group.rotation.y = (Math.random() - 0.5) * 0.24;
        return group;
    }

    _buildWoodenBridge() {
        const group = new THREE.Group();
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x8B6B3B, roughness: 0.9 });
        const bridgeLen = 5 + Math.random() * 3;

        // 板
        for (let x = 0; x < bridgeLen; x += 0.5) {
            const plank = new THREE.Mesh(
                new THREE.BoxGeometry(0.45, 0.08, 2.0),
                woodMat
            );
            plank.position.set(x - bridgeLen / 2, 0.5, 0);
            plank.rotation.y = (Math.random() - 0.5) * 0.05;
            group.add(plank);
        }

        // 支柱
        for (let x of [-bridgeLen / 2, 0, bridgeLen / 2]) {
            for (let z of [-1.0, 1.0]) {
                const post = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.08, 0.1, 1.0, 6),
                    woodMat
                );
                post.position.set(x, 0.0, z);
                group.add(post);
            }
        }

        // 手すり
        for (let z of [-1.05, 1.05]) {
            const rail = new THREE.Mesh(
                new THREE.BoxGeometry(bridgeLen + 0.5, 0.06, 0.06),
                woodMat
            );
            rail.position.set(0, 0.9, z);
            group.add(rail);
        }
        return group;
    }

    /* ========================================================
     *  RESET
     * ======================================================== */
    reset(scrollZ) {
        this.chunks.forEach(chunk => {
            chunk.objects.forEach(obj => {
                this.scene.remove(obj);
                obj.traverse(child => {
                    if (child.isMesh) {
                        child.geometry.dispose();
                        if (child.material.dispose) child.material.dispose();
                    }
                });
            });
        });
        this.chunks = [];
        // ダイナミックプロップは全てチャンクの子なのでここで参照だけ全捨て
        // （捨てないと update() が解放済 Mesh を触ってメモリリーク+描画破綻の原因になる）
        this.dynamicProps = [];
        this.lastChunkZ = scrollZ - this.chunkSize;
        for (let z = scrollZ - this.chunkSize; z <= scrollZ + this.chunkSize * 2; z += this.chunkSize) {
            this._generateChunk(z);
        }
    }

    /* ========================================================
     *  LATE-STAGE DYNAMIC PROPS（Metal Slug 後半ステージ精緻化）
     *  各ビルダー関数は g (THREE.Group) にメッシュを追加して g を返す。
     *  動的要素（炎・煙・揺れ等）は this.dynamicProps に登録し update で更新。
     * ======================================================== */

    // 燃える石油櫓: 4本の鉄骨タワー + 上部の炎 + 黒煙
    _buildBurningDerrick(g) {
        const towerMat = new THREE.MeshStandardMaterial({ color: 0x3A3225, roughness: 0.85, metalness: 0.4 });
        const beamGeo = new THREE.BoxGeometry(0.18, 7.0, 0.18);
        // 4 本の脚（外向き傾斜）
        const legs = [];
        for (let i = 0; i < 4; i++) {
            const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
            const leg = new THREE.Mesh(beamGeo, towerMat);
            leg.position.set(Math.cos(ang) * 1.0, 3.5, Math.sin(ang) * 1.0);
            leg.rotation.x = Math.sin(ang) * 0.12;
            leg.rotation.z = -Math.cos(ang) * 0.12;
            g.add(leg);
            legs.push(leg);
        }
        // 横補強（X 字 x3 段）
        const braceGeo = new THREE.BoxGeometry(2.2, 0.08, 0.08);
        for (let y = 1.4; y < 6.5; y += 1.5) {
            for (let r = 0; r < 4; r++) {
                const b = new THREE.Mesh(braceGeo, towerMat);
                b.position.y = y;
                b.rotation.y = (r * Math.PI / 2);
                b.position.x = Math.cos(r * Math.PI / 2) * 1.0;
                b.position.z = Math.sin(r * Math.PI / 2) * 1.0;
                b.rotation.z = (r % 2) * 0.15;
                g.add(b);
            }
        }
        // パイプ（中央）
        const pipe = new THREE.Mesh(
            new THREE.CylinderGeometry(0.18, 0.18, 7.5, 10),
            new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.6, roughness: 0.5 })
        );
        pipe.position.y = 3.75;
        g.add(pipe);
        // 炎（複数の重ねた半透明スプライト風）
        const flameLayers = [];
        for (let i = 0; i < 5; i++) {
            const f = new THREE.Mesh(
                new THREE.ConeGeometry(0.6 - i * 0.06, 1.2 + i * 0.2, 8),
                new THREE.MeshBasicMaterial({
                    color: i < 2 ? 0xFFEE88 : (i < 4 ? 0xFF7722 : 0xCC2211),
                    transparent: true, opacity: 0.85 - i * 0.08,
                })
            );
            f.position.y = 7.0 + i * 0.25;
            g.add(f);
            flameLayers.push(f);
        }
        // 黒煙（円盤を上空に重ねる）
        const smokePuffs = [];
        for (let i = 0; i < 4; i++) {
            const s = new THREE.Mesh(
                new THREE.SphereGeometry(0.7 + i * 0.15, 8, 6),
                new THREE.MeshBasicMaterial({
                    color: 0x222222, transparent: true, opacity: 0.55 - i * 0.1,
                })
            );
            s.position.set((Math.random() - 0.5) * 0.6, 8.5 + i * 0.6, (Math.random() - 0.5) * 0.6);
            g.add(s);
            smokePuffs.push({ mesh: s, baseY: s.position.y, phase: Math.random() * Math.PI * 2 });
        }
        this.dynamicProps.push({ type: 'derrick', flameLayers, smokePuffs, time: 0 });
        return g;
    }

    // 工業煙突（赤白縞）+ 立ち昇る煙
    _buildSmokestack(g) {
        const stripe1 = new THREE.MeshStandardMaterial({ color: 0xC4C4C4, roughness: 0.85 });
        const stripe2 = new THREE.MeshStandardMaterial({ color: 0xB13322, roughness: 0.8 });
        // 8 段の縞
        for (let i = 0; i < 8; i++) {
            const r = 0.65 - i * 0.025;
            const seg = new THREE.Mesh(new THREE.CylinderGeometry(r, r + 0.02, 0.85, 12), i % 2 ? stripe2 : stripe1);
            seg.position.y = 0.4 + i * 0.85;
            g.add(seg);
        }
        // 上端のリム
        const rim = new THREE.Mesh(
            new THREE.CylinderGeometry(0.50, 0.55, 0.18, 14),
            new THREE.MeshStandardMaterial({ color: 0x3A3A3A, metalness: 0.6, roughness: 0.4 })
        );
        rim.position.y = 7.3;
        g.add(rim);
        // 煙（複数の黒灰色玉）
        const smokePuffs = [];
        for (let i = 0; i < 5; i++) {
            const s = new THREE.Mesh(
                new THREE.SphereGeometry(0.55 + i * 0.18, 8, 6),
                new THREE.MeshBasicMaterial({
                    color: i < 2 ? 0x444444 : 0x666666, transparent: true, opacity: 0.7 - i * 0.1,
                })
            );
            s.position.set(0, 7.6 + i * 0.7, 0);
            g.add(s);
            smokePuffs.push({ mesh: s, baseY: s.position.y, phase: Math.random() * Math.PI * 2 });
        }
        // ベースのコンクリート土台
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(2.0, 0.6, 2.0),
            new THREE.MeshStandardMaterial({ color: 0x6A6A60, roughness: 0.95 })
        );
        base.position.y = 0.3;
        g.add(base);
        this.dynamicProps.push({ type: 'smokestack', smokePuffs, time: 0 });
        return g;
    }

    // ガントリークレーン: 4本脚アーチ + 揺れる吊り鎖 + 鉄製フック
    _buildGantryCrane(g) {
        const steelMat = new THREE.MeshStandardMaterial({ color: 0x6B5520, roughness: 0.7, metalness: 0.4 });
        // アーチの4本柱
        const legGeo = new THREE.BoxGeometry(0.3, 6.0, 0.3);
        for (let x of [-2.5, 2.5]) {
            for (let z of [-1, 1]) {
                const leg = new THREE.Mesh(legGeo, steelMat);
                leg.position.set(x, 3.0, z);
                g.add(leg);
            }
        }
        // 上部の梁（横長）
        const topBeam = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.4, 0.5), steelMat);
        topBeam.position.set(0, 6.0, 0);
        g.add(topBeam);
        // トラス補強（上面）
        for (let i = 0; i < 5; i++) {
            const t = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 1.2), steelMat);
            t.position.set(-2.5 + i * 1.25, 6.0, 0);
            t.rotation.x = i % 2 ? 0.5 : -0.5;
            g.add(t);
        }
        // 中央のキャリッジ + 吊り鎖（揺れる）
        const carriage = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 0.7), steelMat);
        carriage.position.set(0, 5.7, 0);
        g.add(carriage);
        const chainGroup = new THREE.Group();
        chainGroup.position.set(0, 5.6, 0);
        g.add(chainGroup);
        // 鎖のリング 5 個
        const linkMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.7, roughness: 0.4 });
        for (let i = 0; i < 5; i++) {
            const link = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.018, 5, 10), linkMat);
            link.position.y = -0.15 - i * 0.15;
            link.rotation.x = (i % 2) ? Math.PI / 2 : 0;
            chainGroup.add(link);
        }
        // フック
        const hook = new THREE.Mesh(
            new THREE.TorusGeometry(0.18, 0.04, 6, 10, Math.PI * 1.4),
            new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.6, roughness: 0.5 })
        );
        hook.position.y = -0.95;
        hook.rotation.x = Math.PI / 2;
        chainGroup.add(hook);
        // 警告ストライプ
        const warnMat = new THREE.MeshStandardMaterial({ color: 0xE2C24A, roughness: 0.7 });
        const warn = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.12, 0.1), warnMat);
        warn.position.set(0, 5.78, 0.30);
        g.add(warn);
        this.dynamicProps.push({ type: 'crane', chainGroup, time: Math.random() * 5 });
        return g;
    }

    // 撃破された Di-Cokka 戦車（くすぶる残骸）
    _buildWreckedTank(g) {
        const hullMat = new THREE.MeshStandardMaterial({ color: 0x3A3A28, roughness: 0.95 });
        const burntMat = new THREE.MeshStandardMaterial({ color: 0x1A1810, roughness: 1.0 });
        // 焦げた車体
        const hull = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.7, 1.5), hullMat);
        hull.position.y = 0.5;
        hull.rotation.z = 0.08;
        g.add(hull);
        // 焦げた砲塔（ひっくり返り気味）
        const turret = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 1.2), burntMat);
        turret.position.set(0.2, 1.0, 0);
        turret.rotation.z = 0.25;
        turret.rotation.y = 0.4;
        g.add(turret);
        // 折れた砲身
        const barrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.11, 0.11, 1.4, 8),
            burntMat
        );
        barrel.rotation.z = Math.PI / 2 + 0.5; // 折れ曲がり
        barrel.position.set(1.3, 1.1, 0);
        g.add(barrel);
        // 砕けたキャタピラ片
        const trackMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 });
        for (let s of [-1, 1]) {
            const track = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.25, 0.3), trackMat);
            track.position.set(0, 0.13, s * 0.85);
            track.rotation.z = s * 0.05;
            g.add(track);
            // 千切れたパッド
            for (let i = 0; i < 3; i++) {
                const pad = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.28), trackMat);
                pad.position.set(-1.2 + i * 0.5, 0.05, s * 1.1);
                pad.rotation.y = Math.random() * 0.5;
                pad.rotation.z = (Math.random() - 0.5) * 0.4;
                g.add(pad);
            }
        }
        // 焦げ穴（黒い円盤を車体に貼る）
        const hole = new THREE.Mesh(
            new THREE.CircleGeometry(0.2, 8),
            new THREE.MeshBasicMaterial({ color: 0x080604 })
        );
        hole.position.set(0.3, 0.7, 0.76);
        hole.rotation.y = -0.1;
        g.add(hole);
        // くすぶる細い煙
        const smokePuffs = [];
        for (let i = 0; i < 3; i++) {
            const s = new THREE.Mesh(
                new THREE.SphereGeometry(0.25 + i * 0.10, 7, 5),
                new THREE.MeshBasicMaterial({
                    color: 0x4a4a4a, transparent: true, opacity: 0.55 - i * 0.12,
                })
            );
            s.position.set(0.3, 1.5 + i * 0.5, 0);
            g.add(s);
            smokePuffs.push({ mesh: s, baseY: s.position.y, phase: Math.random() * Math.PI * 2 });
        }
        // 残り火（小さな赤点）
        const ember = new THREE.Mesh(
            new THREE.SphereGeometry(0.10, 6, 4),
            new THREE.MeshBasicMaterial({ color: 0xFF5522 })
        );
        ember.position.set(0.3, 0.7, 0.78);
        g.add(ember);
        this.dynamicProps.push({ type: 'wreck', smokePuffs, ember, time: Math.random() * 3 });
        return g;
    }

    // 対空砲台: 土嚢で囲まれた高射砲（旋回する銃身）
    _buildAntiAirGun(g) {
        // 土嚢サークル
        const sandMat = new THREE.MeshStandardMaterial({ color: 0x9B8B5B, roughness: 0.95 });
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            for (let layer = 0; layer < 2; layer++) {
                const sb = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.28, 0.32), sandMat);
                sb.position.set(Math.cos(a) * 1.6, 0.15 + layer * 0.30, Math.sin(a) * 1.6);
                sb.rotation.y = a + Math.PI / 2;
                g.add(sb);
            }
        }
        // 中央のコンクリート基礎
        const base = new THREE.Mesh(
            new THREE.CylinderGeometry(0.7, 0.8, 0.4, 14),
            new THREE.MeshStandardMaterial({ color: 0x5a5a4a, roughness: 0.9 })
        );
        base.position.y = 0.20;
        g.add(base);
        // 砲塔（旋回部）
        const gunGroup = new THREE.Group();
        gunGroup.position.y = 0.4;
        g.add(gunGroup);
        const turret = new THREE.Mesh(
            new THREE.BoxGeometry(0.7, 0.4, 0.9),
            new THREE.MeshStandardMaterial({ color: 0x3a4828, roughness: 0.6, metalness: 0.4 })
        );
        turret.position.y = 0.25;
        gunGroup.add(turret);
        // 4 連装の銃身（上向き）
        const barrelMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.6, roughness: 0.4 });
        for (let i = 0; i < 4; i++) {
            const bx = (i % 2 - 0.5) * 0.18;
            const bz = (Math.floor(i / 2) - 0.5) * 0.18;
            const b = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 8), barrelMat);
            b.position.set(bx, 1.15, bz);
            gunGroup.add(b);
            // 冷却リブ
            for (let r = 0; r < 4; r++) {
                const rib = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.01, 5, 10), barrelMat);
                rib.position.set(bx, 0.7 + r * 0.2, bz);
                rib.rotation.x = Math.PI / 2;
                gunGroup.add(rib);
            }
        }
        // 砲口（暗い円）
        const muzzle = new THREE.Mesh(new THREE.CircleGeometry(0.10, 8),
            new THREE.MeshBasicMaterial({ color: 0x080604 }));
        muzzle.position.set(0, 1.85, 0);
        muzzle.rotation.x = Math.PI / 2;
        gunGroup.add(muzzle);
        // 弾薬箱
        const ammoMat = new THREE.MeshStandardMaterial({ color: 0x4A4A2A, roughness: 0.9 });
        const ammo = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.5), ammoMat);
        ammo.position.set(-1.2, 0.5, 0.5);
        g.add(ammo);
        this.dynamicProps.push({ type: 'aagun', gunGroup, time: Math.random() * 5 });
        return g;
    }

    // 巨大反逆軍旗（風になびく赤旗 + ロゴ星）
    _buildRebelBanner(g) {
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x3A2818, roughness: 0.85 });
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.12, 7.0, 10), poleMat);
        pole.position.y = 3.5;
        g.add(pole);
        // 旗本体（揺れる: 個別 group で動かす）
        const flagGroup = new THREE.Group();
        flagGroup.position.set(0, 6.0, 0.55);
        g.add(flagGroup);
        const flagMat = new THREE.MeshStandardMaterial({
            color: 0xB12822, side: THREE.DoubleSide, roughness: 0.85,
        });
        // 旗をセグメントに分割（波打ち表現）
        const segs = [];
        for (let i = 0; i < 5; i++) {
            const seg = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 1.6), flagMat);
            seg.position.set(0.3 + i * 0.6, 0, 0);
            seg.rotation.y = Math.PI / 2;
            flagGroup.add(seg);
            segs.push(seg);
        }
        // 星章（黄色）
        const starMat = new THREE.MeshStandardMaterial({ color: 0xE2C24A, metalness: 0.6, roughness: 0.4 });
        const star = new THREE.Mesh(new THREE.SphereGeometry(0.30, 8, 6), starMat);
        star.position.set(1.3, 0, -0.05);
        star.scale.set(1.0, 1.0, 0.2);
        flagGroup.add(star);
        // ポールの上端の球飾り
        const knob = new THREE.Mesh(
            new THREE.SphereGeometry(0.16, 8, 6),
            new THREE.MeshStandardMaterial({ color: 0xCFAE54, metalness: 0.7, roughness: 0.3 })
        );
        knob.position.y = 7.1;
        g.add(knob);
        // ベース
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(0.8, 0.4, 0.8),
            new THREE.MeshStandardMaterial({ color: 0x5a5a4a, roughness: 0.9 })
        );
        base.position.y = 0.20;
        g.add(base);
        this.dynamicProps.push({ type: 'banner', flagGroup, segs, time: Math.random() * 10 });
        return g;
    }

    // サーチライト塔（回転する光線）
    _buildSearchlightTower(g) {
        const steelMat = new THREE.MeshStandardMaterial({ color: 0x4A4A4A, metalness: 0.5, roughness: 0.6 });
        // 4本足のトラス塔
        for (let x of [-0.7, 0.7]) {
            for (let z of [-0.7, 0.7]) {
                const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 6.0, 0.14), steelMat);
                leg.position.set(x * 0.7, 3.0, z * 0.7);
                leg.rotation.x = z * 0.05;
                leg.rotation.z = -x * 0.05;
                g.add(leg);
            }
        }
        // X ブレース
        for (let y = 1.2; y < 5.8; y += 1.5) {
            for (let r = 0; r < 4; r++) {
                const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 0.06), steelMat);
                b.position.y = y;
                b.position.x = Math.cos(r * Math.PI / 2) * 0.5;
                b.position.z = Math.sin(r * Math.PI / 2) * 0.5;
                b.rotation.y = r * Math.PI / 2;
                b.rotation.z = (r % 2 ? 0.4 : -0.4);
                g.add(b);
            }
        }
        // 上部プラットフォーム
        const platform = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.15, 1.4), steelMat);
        platform.position.y = 6.0;
        g.add(platform);
        // 回転する灯火（円筒 + 前面のレンズ）
        const lightGroup = new THREE.Group();
        lightGroup.position.set(0, 6.4, 0);
        g.add(lightGroup);
        const housing = new THREE.Mesh(
            new THREE.CylinderGeometry(0.4, 0.4, 0.6, 12),
            new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.5, roughness: 0.5 })
        );
        housing.rotation.z = Math.PI / 2;
        lightGroup.add(housing);
        const lens = new THREE.Mesh(
            new THREE.CircleGeometry(0.36, 14),
            new THREE.MeshBasicMaterial({ color: 0xFFF8B0 })
        );
        lens.position.x = 0.31;
        lens.rotation.y = -Math.PI / 2;
        lightGroup.add(lens);
        // 光線（円錐、半透明）
        const beam = new THREE.Mesh(
            new THREE.ConeGeometry(1.2, 8, 14, 1, true),
            new THREE.MeshBasicMaterial({
                color: 0xFFF4A0, transparent: true, opacity: 0.18,
                side: THREE.DoubleSide, depthWrite: false,
            })
        );
        beam.rotation.z = -Math.PI / 2;
        beam.position.x = 4.2;
        lightGroup.add(beam);
        this.dynamicProps.push({ type: 'searchlight', lightGroup, time: Math.random() * 10 });
        return g;
    }

    // 装甲ゲート（左右の重スライド扉 + 警告灯）
    _buildFortressGate(g) {
        const concreteMat = _sharedMat('gate_concrete', () => new THREE.MeshStandardMaterial({ color: 0x6A675E, roughness: 0.92 }));
        const steelMat = _sharedMat('gate_steel', () => new THREE.MeshStandardMaterial({ color: 0x3A3F45, roughness: 0.55, metalness: 0.45 }));
        const stripeMat = _sharedMat('gate_stripe', () => new THREE.MeshStandardMaterial({ color: 0xC28A24, roughness: 0.85 }));

        const base = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.5, 2.4), concreteMat);
        base.position.y = 0.25;
        g.add(base);

        for (const x of [-2.0, 2.0]) {
            const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.1, 4.6, 1.2), concreteMat);
            pillar.position.set(x, 2.3, 0);
            g.add(pillar);
        }

        const lintel = new THREE.Mesh(new THREE.BoxGeometry(5.1, 0.9, 1.3), concreteMat);
        lintel.position.y = 4.8;
        g.add(lintel);

        const leftDoor = new THREE.Mesh(new THREE.BoxGeometry(1.7, 3.7, 0.22), steelMat);
        leftDoor.position.set(-0.9, 2.15, 0);
        g.add(leftDoor);
        const rightDoor = new THREE.Mesh(new THREE.BoxGeometry(1.7, 3.7, 0.22), steelMat);
        rightDoor.position.set(0.9, 2.15, 0);
        g.add(rightDoor);

        for (let i = 0; i < 4; i++) {
            const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.65, 0.03), stripeMat);
            stripe.position.set(-0.2 + i * 0.4, 2.2, 0.13);
            stripe.rotation.z = Math.PI / 6;
            g.add(stripe);
        }

        const lampMats = [];
        for (const x of [-2.25, 2.25]) {
            const lampMat = new THREE.MeshBasicMaterial({ color: 0xFF3311, transparent: true, opacity: 0.9 });
            lampMats.push(lampMat);
            const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), lampMat);
            lamp.position.set(x, 5.35, 0.45);
            g.add(lamp);
        }

        this.dynamicProps.push({ type: 'fortress_gate', leftDoor, rightDoor, lampMats, time: Math.random() * 10 });
        return g;
    }

    // レーダードーム（回転皿 + 警告ビーコン）
    _buildRadarDome(g) {
        const domeMat = _sharedMat('radar_dome', () => new THREE.MeshStandardMaterial({ color: 0x868B90, roughness: 0.6, metalness: 0.3 }));
        const baseMat = _sharedMat('radar_base', () => new THREE.MeshStandardMaterial({ color: 0x5E6368, roughness: 0.85 }));
        const dishMat = _sharedMat('radar_dish', () => new THREE.MeshStandardMaterial({ color: 0xB6BDC4, roughness: 0.45, metalness: 0.55 }));

        const base = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.2, 1.1, 16), baseMat);
        base.position.y = 0.55;
        g.add(base);

        const dome = new THREE.Mesh(new THREE.SphereGeometry(1.7, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), domeMat);
        dome.position.y = 1.35;
        g.add(dome);

        const radarGroup = new THREE.Group();
        radarGroup.position.set(0, 2.1, 0);
        g.add(radarGroup);

        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.0, 8), baseMat);
        mast.position.y = 0.5;
        radarGroup.add(mast);

        const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.08, 0.28, 16), dishMat);
        dish.position.y = 1.1;
        dish.rotation.z = -0.35;
        radarGroup.add(dish);

        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.08, 0.08), baseMat);
        arm.position.y = 1.1;
        arm.position.x = 0.42;
        radarGroup.add(arm);

        const beaconMats = [];
        for (const z of [-1.5, 1.5]) {
            const lampMat = new THREE.MeshBasicMaterial({ color: 0xFF4422, transparent: true, opacity: 0.5 });
            beaconMats.push(lampMat);
            const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.11, 7, 5), lampMat);
            beacon.position.set(0, 0.95, z);
            g.add(beacon);
        }

        this.dynamicProps.push({ type: 'radar', radarGroup, beaconMats, time: Math.random() * 10 });
        return g;
    }

    // 古代の砂漠ピラミッド遺跡（風化した破損形状）
    _buildPyramidRuin(g) {
        const stoneMat = new THREE.MeshStandardMaterial({ color: 0xA89668, roughness: 0.95 });
        // 4 層の積み重ね（上に行くほど狭く、欠損気味）
        const layers = [
            { w: 5.0, h: 0.9, off: 0 },
            { w: 4.0, h: 0.8, off: 0.05 },
            { w: 3.0, h: 0.7, off: -0.10 },
            { w: 2.0, h: 0.6, off: 0.08 },
        ];
        let y = 0;
        for (let i = 0; i < layers.length; i++) {
            const L = layers[i];
            const block = new THREE.Mesh(new THREE.BoxGeometry(L.w, L.h, L.w), stoneMat);
            block.position.set(L.off, y + L.h / 2, L.off);
            block.rotation.y = (i % 2) * 0.04;
            g.add(block);
            y += L.h;
        }
        // 頂上欠損: 斜め切り風の小さなブロック
        const topChunk = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.4, 1.0), stoneMat);
        topChunk.position.set(0.2, y + 0.2, -0.1);
        topChunk.rotation.y = 0.4;
        topChunk.rotation.z = 0.2;
        g.add(topChunk);
        // 入口（黒い四角穴）
        const door = new THREE.Mesh(
            new THREE.BoxGeometry(0.6, 1.0, 0.05),
            new THREE.MeshBasicMaterial({ color: 0x100A06 })
        );
        door.position.set(0, 0.5, 2.51);
        g.add(door);
        // 風化のひび（細い暗い帯）
        const crackMat = new THREE.MeshBasicMaterial({ color: 0x5a4828 });
        for (let i = 0; i < 4; i++) {
            const c = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.5 + Math.random() * 0.5, 0.02), crackMat);
            c.position.set((Math.random() - 0.5) * 4, 1.0 + Math.random() * 1.5, 2.51);
            c.rotation.z = (Math.random() - 0.5) * 0.4;
            g.add(c);
        }
        // ヒエログリフ風の浅い装飾（金色帯）
        const goldMat = new THREE.MeshStandardMaterial({ color: 0xCFAE54, metalness: 0.5, roughness: 0.6 });
        const band = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.10, 0.05), goldMat);
        band.position.set(0, 0.3, 2.52);
        g.add(band);
        return g;
    }

    // 崩落高層廃墟（斜めに傾いた多層ブロック）
    _buildCollapsedHighrise(g) {
        const wallMat = _sharedMat('highrise_wall', () => new THREE.MeshStandardMaterial({ color: 0x7A7468, roughness: 0.92 }));
        const frameMat = _sharedMat('highrise_frame', () => new THREE.MeshStandardMaterial({ color: 0x4F4A42, roughness: 0.75, metalness: 0.2 }));
        const windowMat = _sharedMat('highrise_window', () => new THREE.MeshStandardMaterial({ color: 0x1D252D, roughness: 0.35, metalness: 0.25 }));

        const core = new THREE.Mesh(new THREE.BoxGeometry(4.2, 7.4, 2.8), wallMat);
        core.position.set(0, 3.7, 0);
        core.rotation.z = -0.10;
        g.add(core);

        const annex = new THREE.Mesh(new THREE.BoxGeometry(2.2, 4.6, 2.4), wallMat);
        annex.position.set(-2.2, 2.3, 0.1);
        annex.rotation.z = 0.14;
        g.add(annex);

        for (let y = 1.0; y <= 6.2; y += 1.1) {
            for (let z = -0.9; z <= 0.9; z += 0.9) {
                const win = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.55, 0.42), windowMat);
                win.position.set(2.06, y, z);
                win.rotation.z = -0.10;
                g.add(win);
            }
        }

        for (let i = 0; i < 6; i++) {
            const beam = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.0 + Math.random() * 1.2, 0.14), frameMat);
            beam.position.set(-1.0 + i * 0.4, 0.5 + Math.random() * 1.1, -1.1 + Math.random() * 2.2);
            beam.rotation.set((Math.random() - 0.5) * 0.5, Math.random() * Math.PI, (Math.random() - 0.5) * 0.7);
            g.add(beam);
        }

        return g;
    }

    // 砲撃跡クレーター帯（終盤の地形変化）
    _buildCraterBelt(g, intensity = 2) {
        const dirtMat = _sharedMat('crater_dirt', () => new THREE.MeshStandardMaterial({ color: 0x7B5E3A, roughness: 0.96 }));
        const rimMat = _sharedMat('crater_rim', () => new THREE.MeshStandardMaterial({ color: 0x9B7347, roughness: 0.94 }));
        const coreMat = _sharedMat('crater_core', () => new THREE.MeshBasicMaterial({ color: 0x2A2218 }));
        const steelMat = _sharedMat('crater_steel', () => new THREE.MeshStandardMaterial({ color: 0x454545, roughness: 0.6, metalness: 0.4 }));

        const craterCount = 2 + Math.min(4, intensity);
        for (let i = 0; i < craterCount; i++) {
            const radius = 0.75 + Math.random() * (0.45 + intensity * 0.08);
            const cg = new THREE.Group();
            cg.position.set((Math.random() - 0.5) * 5.2, 0, (Math.random() - 0.5) * 2.6);

            const core = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.78, radius * 0.92, 0.05, 12), coreMat);
            core.position.y = 0.02;
            cg.add(core);

            const rim = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.11 + Math.random() * 0.04, 6, 14), rimMat);
            rim.position.y = 0.05;
            rim.rotation.x = Math.PI / 2;
            cg.add(rim);

            // 飛散した土塊・鉄片
            const debrisCount = 3 + Math.floor(Math.random() * 4);
            for (let d = 0; d < debrisCount; d++) {
                const isSteel = Math.random() > 0.68;
                const piece = new THREE.Mesh(
                    isSteel
                        ? new THREE.BoxGeometry(0.10 + Math.random() * 0.2, 0.05 + Math.random() * 0.08, 0.05 + Math.random() * 0.18)
                        : new THREE.DodecahedronGeometry(0.09 + Math.random() * 0.13, 0),
                    isSteel ? steelMat : dirtMat
                );
                const a = Math.random() * Math.PI * 2;
                const r = radius * (1.1 + Math.random() * 0.8);
                piece.position.set(Math.cos(a) * r, 0.06 + Math.random() * 0.2, Math.sin(a) * r);
                piece.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
                cg.add(piece);
            }

            g.add(cg);
        }
        return g;
    }

    // 塹壕 + 土嚢 + 鉄条線の複合バリケード
    _buildTrenchBarricade(g, phase = 0) {
        const soilMat = _sharedMat('trench_soil', () => new THREE.MeshStandardMaterial({ color: 0x8B6B44, roughness: 0.97 }));
        const darkSoil = _sharedMat('trench_dark', () => new THREE.MeshStandardMaterial({ color: 0x3A2E1F, roughness: 1.0 }));
        const bagMat = _sharedMat('trench_bag', () => new THREE.MeshStandardMaterial({ color: 0xA78E62, roughness: 0.95 }));
        const poleMat = _sharedMat('trench_pole', () => new THREE.MeshStandardMaterial({ color: 0x4E3A24, roughness: 0.9 }));
        const wireMat = _sharedMat('trench_wire', () => new THREE.MeshBasicMaterial({ color: 0x888888 }));

        const len = 4.2 + phase * 0.7;
        const trenchFloor = new THREE.Mesh(new THREE.BoxGeometry(len, 0.06, 1.6), darkSoil);
        trenchFloor.position.y = 0.03;
        g.add(trenchFloor);
        const sideA = new THREE.Mesh(new THREE.BoxGeometry(len, 0.45, 0.48), soilMat);
        sideA.position.set(0, 0.22, -1.0);
        g.add(sideA);
        const sideB = new THREE.Mesh(new THREE.BoxGeometry(len, 0.45, 0.48), soilMat);
        sideB.position.set(0, 0.22, 1.0);
        g.add(sideB);

        // 塹壕前縁の土嚢列
        const bagCount = 6 + phase;
        for (let i = 0; i < bagCount; i++) {
            const b = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.22, 0.28), bagMat);
            b.position.set(-len / 2 + 0.35 + i * (len / bagCount), 0.42 + (i % 2) * 0.05, 1.18);
            b.rotation.y = (Math.random() - 0.5) * 0.18;
            g.add(b);
        }

        // 鉄条線
        const postCount = 4 + phase;
        for (let i = 0; i < postCount; i++) {
            const x = -len / 2 + i * (len / Math.max(1, postCount - 1));
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.95, 5), poleMat);
            post.position.set(x, 0.48, 1.52);
            post.rotation.z = (Math.random() - 0.5) * 0.12;
            g.add(post);
            for (let h = 0.28; h <= 0.72; h += 0.22) {
                const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.9, 4), wireMat);
                wire.position.set(x + 0.45, h, 1.52);
                wire.rotation.y = Math.PI / 2;
                g.add(wire);
            }
        }

        return g;
    }

    // 重装バンカー（終盤の大型防衛建造物）
    _buildFortifiedBunker(g) {
        const concreteMat = _sharedMat('bunker_concrete', () => new THREE.MeshStandardMaterial({ color: 0x6F6A61, roughness: 0.94 }));
        const steelMat = _sharedMat('bunker_steel', () => new THREE.MeshStandardMaterial({ color: 0x3A3F44, roughness: 0.55, metalness: 0.5 }));
        const darkMat = _sharedMat('bunker_dark', () => new THREE.MeshBasicMaterial({ color: 0x14100C }));
        const stripeMat = _sharedMat('bunker_stripe', () => new THREE.MeshStandardMaterial({ color: 0xB7832A, roughness: 0.86 }));

        const body = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.8, 2.6), concreteMat);
        body.position.y = 0.9;
        g.add(body);
        const roof = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.36, 2.9), concreteMat);
        roof.position.y = 1.95;
        g.add(roof);

        // 射撃スリット
        for (const z of [-0.75, 0.0, 0.75]) {
            const slit = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.5), darkMat);
            slit.position.set(1.92, 1.05, z);
            g.add(slit);
        }

        // 側面補強
        for (const z of [-1.15, 1.15]) {
            const butt = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.2, 0.35), concreteMat);
            butt.position.set(-0.15, 0.7, z);
            g.add(butt);
        }

        // 上部ハッチ
        const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.12, 10), steelMat);
        hatch.position.set(-0.6, 2.2, 0);
        g.add(hatch);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.03, 6, 14), steelMat);
        ring.position.set(-0.6, 2.26, 0);
        ring.rotation.x = Math.PI / 2;
        g.add(ring);

        // 警告マーキング
        for (let i = 0; i < 3; i++) {
            const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.5, 0.05), stripeMat);
            stripe.position.set(1.94, 0.65 + i * 0.45, -1.22);
            stripe.rotation.z = Math.PI / 5;
            g.add(stripe);
        }
        return g;
    }

    // 崩落高架（波打つ終盤地形）
    _buildBrokenOverpass(g, phase = 0) {
        const concreteMat = _sharedMat('overpass_concrete', () => new THREE.MeshStandardMaterial({ color: 0x7A7468, roughness: 0.95 }));
        const rustMat = _sharedMat('overpass_rust', () => new THREE.MeshStandardMaterial({ color: 0x6A3E22, roughness: 0.92, metalness: 0.25 }));

        const span = 6.5 + phase * 0.6;
        const deckA = new THREE.Mesh(new THREE.BoxGeometry(span * 0.58, 0.38, 2.2), concreteMat);
        deckA.position.set(-span * 0.15, 2.9, 0);
        deckA.rotation.z = -0.24;
        g.add(deckA);
        const deckB = new THREE.Mesh(new THREE.BoxGeometry(span * 0.46, 0.34, 2.0), concreteMat);
        deckB.position.set(span * 0.25, 2.2, 0.35);
        deckB.rotation.z = 0.33;
        g.add(deckB);

        for (const x of [-2.4, 0.2, 2.1]) {
            const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 2.4 + Math.random() * 1.2, 0.9), concreteMat);
            pillar.position.set(x, 1.1 + Math.random() * 0.35, -0.65 + Math.random() * 1.3);
            pillar.rotation.z = (Math.random() - 0.5) * 0.12;
            g.add(pillar);
        }

        // 飛び出した鉄筋
        for (let i = 0; i < 6 + phase; i++) {
            const rebar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6 + Math.random() * 0.8, 5), rustMat);
            rebar.position.set(1.2 + (Math.random() - 0.5) * 2.2, 2.4 + Math.random() * 1.0, (Math.random() - 0.5) * 1.6);
            rebar.rotation.set(Math.random(), Math.random() * Math.PI, Math.random());
            g.add(rebar);
        }
        return g;
    }

    // 警報サイレン塔（回転ヘッド + 点滅灯）
    _buildSirenMast(g) {
        const mastMat = _sharedMat('siren_mast', () => new THREE.MeshStandardMaterial({ color: 0x454A52, roughness: 0.62, metalness: 0.45 }));
        const baseMat = _sharedMat('siren_base', () => new THREE.MeshStandardMaterial({ color: 0x6A665C, roughness: 0.9 }));
        const lampCore = _sharedMat('siren_core', () => new THREE.MeshStandardMaterial({ color: 0xAA2918, roughness: 0.35, metalness: 0.35, emissive: 0x330A08 }));

        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 0.55, 12), baseMat);
        base.position.y = 0.28;
        g.add(base);

        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 4.8, 8), mastMat);
        mast.position.y = 2.7;
        g.add(mast);

        const headGroup = new THREE.Group();
        headGroup.position.set(0, 5.15, 0);
        g.add(headGroup);
        const bar = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.16, 0.22), mastMat);
        headGroup.add(bar);
        const hornL = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.45, 8), mastMat);
        hornL.position.x = 0.72;
        hornL.rotation.z = -Math.PI / 2;
        headGroup.add(hornL);
        const hornR = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.45, 8), mastMat);
        hornR.position.x = -0.72;
        hornR.rotation.z = Math.PI / 2;
        headGroup.add(hornR);

        const lampMats = [];
        for (const z of [-0.24, 0.24]) {
            const lm = lampCore.clone();
            const glow = new THREE.MeshBasicMaterial({ color: 0xFF3B1A, transparent: true, opacity: 0.4 });
            lampMats.push({ core: lm, glow });

            const lens = new THREE.Mesh(new THREE.SphereGeometry(0.11, 7, 5), lm);
            lens.position.set(0, 5.35, z);
            g.add(lens);
            const halo = new THREE.Mesh(new THREE.SphereGeometry(0.18, 7, 5), glow);
            halo.position.set(0, 5.35, z);
            g.add(halo);
        }

        this.dynamicProps.push({ type: 'siren', headGroup, lampMats, time: Math.random() * 10 });
        return g;
    }

    // 蒸気噴出パイプ（地面から立ち上がる L 字管 + 蒸気）
    _buildSteamVent(g) {
        const pipeMat = new THREE.MeshStandardMaterial({ color: 0x6a6a6a, metalness: 0.5, roughness: 0.55 });
        const rustMat = new THREE.MeshStandardMaterial({ color: 0x8a4a2a, roughness: 0.85 });
        // 縦管
        const vpipe = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.6, 10), pipeMat);
        vpipe.position.y = 0.8;
        g.add(vpipe);
        // L 字曲がり（球）
        const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.20, 10, 8), pipeMat);
        elbow.position.y = 1.6;
        g.add(elbow);
        // 横管
        const hpipe = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.8, 10), pipeMat);
        hpipe.position.set(0.4, 1.6, 0);
        hpipe.rotation.z = Math.PI / 2;
        g.add(hpipe);
        // 出口リング
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.03, 6, 12), rustMat);
        ring.position.set(0.85, 1.6, 0);
        ring.rotation.y = Math.PI / 2;
        g.add(ring);
        // バルブハンドル
        const valve = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.018, 6, 12), rustMat);
        valve.position.y = 0.6;
        valve.rotation.y = Math.PI / 2;
        g.add(valve);
        // 蒸気（白い半透明球、複数）
        const steamPuffs = [];
        for (let i = 0; i < 5; i++) {
            const s = new THREE.Mesh(
                new THREE.SphereGeometry(0.18 + i * 0.06, 7, 5),
                new THREE.MeshBasicMaterial({
                    color: 0xEEEEEE, transparent: true, opacity: 0.55 - i * 0.10,
                })
            );
            s.position.set(0.85 + i * 0.20, 1.6, 0);
            g.add(s);
            steamPuffs.push({ mesh: s, basePos: s.position.clone(), phase: Math.random() * Math.PI * 2 });
        }
        this.dynamicProps.push({ type: 'steam', steamPuffs, time: Math.random() * 5 });
        return g;
    }

    // 深部要塞の巨大工場ファサード。道路脇の遠景ランドマークとして使う。
    _buildWarFactoryFacade(g, phase = 5) {
        const wallMat = _sharedMat('war_factory_wall', () => new THREE.MeshStandardMaterial({ color: 0x5F625B, roughness: 0.9, metalness: 0.12 }));
        const darkMat = _sharedMat('war_factory_dark', () => new THREE.MeshBasicMaterial({ color: 0x11100E }));
        const steelMat = _sharedMat('war_factory_steel', () => new THREE.MeshStandardMaterial({ color: 0x3D4348, roughness: 0.55, metalness: 0.55 }));
        const rustMat = _sharedMat('war_factory_rust', () => new THREE.MeshStandardMaterial({ color: 0x7B4524, roughness: 0.9, metalness: 0.28 }));
        const warnMat = _sharedMat('war_factory_warn', () => new THREE.MeshStandardMaterial({ color: 0xD0A12A, roughness: 0.78 }));
        const lampMat = _sharedMat('war_factory_lamp', () => new THREE.MeshBasicMaterial({ color: 0xFF3B1E }));

        const h = 6.2 + Math.min(4, phase - 5) * 0.45;
        const main = new THREE.Mesh(new THREE.BoxGeometry(6.8, h, 2.8), wallMat);
        main.position.y = h / 2;
        g.add(main);

        const annex = new THREE.Mesh(new THREE.BoxGeometry(3.0, h * 0.72, 2.6), wallMat);
        annex.position.set(-4.2, h * 0.36, 0.15);
        annex.rotation.z = -0.04;
        g.add(annex);

        const roof = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.45, 3.2), steelMat);
        roof.position.y = h + 0.2;
        g.add(roof);

        for (let y = 1.1; y < h - 0.4; y += 1.0) {
            for (let z = -0.95; z <= 0.95; z += 0.48) {
                const win = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, 0.25), darkMat);
                win.position.set(3.43, y, z);
                g.add(win);
            }
        }

        // 外付け配管とタンク
        for (const z of [-1.45, 1.45]) {
            const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, h * 0.92, 8), rustMat);
            pipe.position.set(3.58, h * 0.47, z);
            g.add(pipe);
            for (let y = 1.2; y < h; y += 1.35) {
                const clamp = new THREE.Mesh(new THREE.TorusGeometry(0.10, 0.014, 5, 10), steelMat);
                clamp.position.set(3.58, y, z);
                clamp.rotation.x = Math.PI / 2;
                g.add(clamp);
            }
        }

        for (let i = 0; i < 3; i++) {
            const vent = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.55), steelMat);
            vent.position.set(3.55, h + 0.55, -0.75 + i * 0.75);
            vent.rotation.z = 0.08;
            g.add(vent);
            const glow = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 4), lampMat);
            glow.position.set(3.95, h + 0.62, -0.75 + i * 0.75);
            g.add(glow);
        }

        // 前面のキャットウォークと斜め補強
        const walk = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.12, 0.55), steelMat);
        walk.position.set(3.62, 3.1, 0);
        g.add(walk);
        for (let z = -1.2; z <= 1.2; z += 0.4) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.55, 0.04), steelMat);
            rail.position.set(3.66, 3.42, z);
            g.add(rail);
        }
        for (let i = 0; i < 5; i++) {
            const brace = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, 0.08), steelMat);
            brace.position.set(3.70, 2.6, -1.05 + i * 0.52);
            brace.rotation.z = i % 2 ? 0.38 : -0.38;
            g.add(brace);
        }

        // 警告ストライプ付き搬入口
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.10, 1.7, 1.4), darkMat);
        door.position.set(3.48, 0.88, 0);
        g.add(door);
        for (let i = 0; i < 6; i++) {
            const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.32, 0.06), i % 2 ? warnMat : steelMat);
            stripe.position.set(3.55, 0.25 + i * 0.25, -0.72);
            stripe.rotation.z = Math.PI / 5;
            g.add(stripe);
        }

        return g;
    }

    // 深部要塞の線路・コンクリート障害物。道路中央にも出せる地形変化。
    _buildRailYardBarricade(g, phase = 5) {
        const railMat = _sharedMat('rail_yard_rail', () => new THREE.MeshStandardMaterial({ color: 0x3A3A3A, roughness: 0.45, metalness: 0.75 }));
        const sleeperMat = _sharedMat('rail_yard_sleeper', () => new THREE.MeshStandardMaterial({ color: 0x4A2D1A, roughness: 0.92 }));
        const concreteMat = _sharedMat('rail_yard_concrete', () => new THREE.MeshStandardMaterial({ color: 0x777169, roughness: 0.94 }));
        const hazardMat = _sharedMat('rail_yard_hazard', () => new THREE.MeshStandardMaterial({ color: 0xC5972A, roughness: 0.82 }));

        const len = 6.0 + Math.min(4, phase - 5) * 0.7;
        for (const z of [-0.52, 0.52]) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.10, 0.08), railMat);
            rail.position.set(0, 0.12, z);
            rail.rotation.z = (Math.random() - 0.5) * 0.04;
            g.add(rail);
        }
        for (let i = 0; i < 9; i++) {
            const sleeper = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 1.55), sleeperMat);
            sleeper.position.set(-len / 2 + i * (len / 8), 0.06, 0);
            sleeper.rotation.y = (Math.random() - 0.5) * 0.16;
            g.add(sleeper);
        }

        for (const x of [-2.0, 0.2, 2.3]) {
            const block = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.55, 0.9), concreteMat);
            block.position.set(x, 0.34, 1.15 + (Math.random() - 0.5) * 0.4);
            block.rotation.y = (Math.random() - 0.5) * 0.35;
            g.add(block);
            const plate = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.06, 0.92), hazardMat);
            plate.position.set(x, 0.65, block.position.z);
            plate.rotation.y = block.rotation.y;
            g.add(plate);
        }

        for (let i = 0; i < 5; i++) {
            const mine = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.20, 0.08, 10), railMat);
            mine.position.set(-2.5 + i * 1.1, 0.08, -1.12 + (i % 2) * 0.35);
            g.add(mine);
            const cap = new THREE.Mesh(new THREE.SphereGeometry(0.04, 5, 4), hazardMat);
            cap.position.set(mine.position.x, 0.15, mine.position.z);
            g.add(cap);
        }

        return g;
    }

    // 旋回する巨大砲座。深部要塞の破壊可能ランドマーク。
    _buildMegaCannonEmplacement(g) {
        const concreteMat = _sharedMat('mega_cannon_concrete', () => new THREE.MeshStandardMaterial({ color: 0x696962, roughness: 0.94 }));
        const steelMat = _sharedMat('mega_cannon_steel', () => new THREE.MeshStandardMaterial({ color: 0x343A40, roughness: 0.48, metalness: 0.62 }));
        const darkMat = _sharedMat('mega_cannon_dark', () => new THREE.MeshBasicMaterial({ color: 0x090909 }));
        const warnMat = _sharedMat('mega_cannon_warn', () => new THREE.MeshStandardMaterial({ color: 0xC79A2E, roughness: 0.75 }));

        const base = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 2.25, 0.65, 18), concreteMat);
        base.position.y = 0.33;
        g.add(base);

        for (let i = 0; i < 10; i++) {
            const a = i / 10 * Math.PI * 2;
            const bag = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.26, 0.32), concreteMat);
            bag.position.set(Math.cos(a) * 2.25, 0.75, Math.sin(a) * 2.25);
            bag.rotation.y = a;
            g.add(bag);
        }

        const turretGroup = new THREE.Group();
        turretGroup.position.y = 0.75;
        g.add(turretGroup);

        const turret = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.75, 1.45), steelMat);
        turret.position.y = 0.45;
        turretGroup.add(turret);
        const barrelGroup = new THREE.Group();
        barrelGroup.position.set(0.75, 0.48, 0);
        turretGroup.add(barrelGroup);

        for (const z of [-0.16, 0.16]) {
            const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 2.55, 10), steelMat);
            barrel.rotation.z = Math.PI / 2;
            barrel.position.set(1.15, 0.0, z);
            barrelGroup.add(barrel);
            const muzzle = new THREE.Mesh(new THREE.RingGeometry(0.10, 0.15, 12), darkMat);
            muzzle.position.set(2.45, 0.0, z);
            muzzle.rotation.y = Math.PI / 2;
            barrelGroup.add(muzzle);
        }

        const ammoDrum = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.52, 12), steelMat);
        ammoDrum.position.set(-0.82, 0.42, 0);
        ammoDrum.rotation.z = Math.PI / 2;
        turretGroup.add(ammoDrum);

        const lampMats = [];
        for (const z of [-0.62, 0.62]) {
            const lm = new THREE.MeshBasicMaterial({ color: 0xFF321A, transparent: true, opacity: 0.65 });
            lampMats.push(lm);
            const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 4), lm);
            lamp.position.set(0.55, 1.15, z);
            turretGroup.add(lamp);
        }

        for (let i = 0; i < 5; i++) {
            const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.38, 0.04), i % 2 ? warnMat : darkMat);
            stripe.position.set(0.75, 0.74, -0.72 + i * 0.36);
            stripe.rotation.z = Math.PI / 5;
            turretGroup.add(stripe);
        }

        this.dynamicProps.push({ type: 'mega_cannon', turretGroup, barrelGroup, lampMats, time: Math.random() * 10 });
        return g;
    }

    // パルス式シールド発生器。透明なリングとコアが脈動する。
    _buildShieldGenerator(g) {
        const baseMat = _sharedMat('shield_gen_base', () => new THREE.MeshStandardMaterial({ color: 0x4F565A, roughness: 0.78, metalness: 0.35 }));
        const coilMat = _sharedMat('shield_gen_coil', () => new THREE.MeshStandardMaterial({ color: 0x2E3238, roughness: 0.44, metalness: 0.7 }));
        const copperMat = _sharedMat('shield_gen_copper', () => new THREE.MeshStandardMaterial({ color: 0xB46A2A, roughness: 0.45, metalness: 0.65 }));

        const base = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.25, 0.55, 16), baseMat);
        base.position.y = 0.28;
        g.add(base);

        const rings = [];
        for (let i = 0; i < 3; i++) {
            const ring = new THREE.Mesh(new THREE.TorusGeometry(0.82 - i * 0.16, 0.035, 8, 18), coilMat);
            ring.position.y = 1.05 + i * 0.52;
            ring.rotation.x = Math.PI / 2;
            g.add(ring);
            rings.push(ring);
        }

        for (let i = 0; i < 4; i++) {
            const a = i / 4 * Math.PI * 2 + Math.PI / 4;
            const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.2, 8), coilMat);
            pylon.position.set(Math.cos(a) * 0.82, 1.25, Math.sin(a) * 0.82);
            g.add(pylon);
            const wire = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.014, 5, 10), copperMat);
            wire.position.set(Math.cos(a) * 0.82, 1.95, Math.sin(a) * 0.82);
            wire.rotation.x = Math.PI / 2;
            g.add(wire);
        }

        const coreMat = new THREE.MeshBasicMaterial({ color: 0x66E8FF, transparent: true, opacity: 0.78 });
        const core = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 8), coreMat);
        core.position.y = 1.78;
        g.add(core);

        const shieldMat = new THREE.MeshBasicMaterial({
            color: 0x66CCFF, transparent: true, opacity: 0.13,
            blending: THREE.AdditiveBlending, depthWrite: false,
            side: THREE.DoubleSide,
        });
        const shield = new THREE.Mesh(new THREE.SphereGeometry(1.65, 18, 10), shieldMat);
        shield.position.y = 1.6;
        shield.scale.set(1.0, 0.78, 1.0);
        g.add(shield);

        this.dynamicProps.push({ type: 'shield_generator', rings, core, coreMat, shield, shieldMat, time: Math.random() * 10 });
        return g;
    }

    // ミサイルサイロ群。ハッチと警告灯が周期的に動く。
    _buildMissileSiloCluster(g) {
        const concreteMat = _sharedMat('silo_concrete', () => new THREE.MeshStandardMaterial({ color: 0x66625B, roughness: 0.94 }));
        const steelMat = _sharedMat('silo_steel', () => new THREE.MeshStandardMaterial({ color: 0x30343A, roughness: 0.52, metalness: 0.55 }));
        const missileMat = _sharedMat('silo_missile', () => new THREE.MeshStandardMaterial({ color: 0xD0D0C8, roughness: 0.48, metalness: 0.32 }));
        const tipMat = _sharedMat('silo_tip', () => new THREE.MeshStandardMaterial({ color: 0xBB2B1E, roughness: 0.5, metalness: 0.22 }));

        const hatches = [];
        const missileGroups = [];
        const beaconMats = [];

        for (let i = 0; i < 3; i++) {
            const x = -1.25 + i * 1.25;
            const silo = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.62, 0.9, 16), concreteMat);
            silo.position.set(x, 0.45, 0);
            g.add(silo);

            const rim = new THREE.Mesh(new THREE.TorusGeometry(0.53, 0.055, 8, 16), steelMat);
            rim.position.set(x, 0.94, 0);
            rim.rotation.x = Math.PI / 2;
            g.add(rim);

            const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.08, 0.95), steelMat);
            hatch.position.set(x - 0.16, 1.04, 0);
            g.add(hatch);
            hatches.push({ mesh: hatch, baseX: hatch.position.x, side: i % 2 ? -1 : 1 });

            const missileGroup = new THREE.Group();
            missileGroup.position.set(x, 0.82, 0);
            g.add(missileGroup);
            const body = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.05, 10), missileMat);
            body.position.y = 0.5;
            missileGroup.add(body);
            const tip = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 10), tipMat);
            tip.position.y = 1.16;
            missileGroup.add(tip);
            missileGroups.push({ group: missileGroup, baseY: missileGroup.position.y, phase: i * 0.55 });

            const lm = new THREE.MeshBasicMaterial({ color: 0xFF3A1F, transparent: true, opacity: 0.45 });
            beaconMats.push(lm);
            const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), lm);
            beacon.position.set(x + 0.42, 1.18, 0.42);
            g.add(beacon);
        }

        const pipeMat = _sharedMat('silo_pipe', () => new THREE.MeshStandardMaterial({ color: 0x454545, roughness: 0.55, metalness: 0.58 }));
        for (const z of [-0.72, 0.72]) {
            const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.4, 8), pipeMat);
            pipe.position.set(0, 0.38, z);
            pipe.rotation.z = Math.PI / 2;
            g.add(pipe);
        }

        this.dynamicProps.push({ type: 'missile_silo', hatches, missileGroups, beaconMats, time: Math.random() * 10 });
        return g;
    }

    /* ========================================================
     *  UPDATE
     * ======================================================== */
    update(dt, scrollZ) {
        // 地面・道路・空の +Z 追従
        if (this.groundMesh) this.groundMesh.position.z = scrollZ;
        if (this.roadMesh) this.roadMesh.position.z = scrollZ;
        if (this.skyMesh) this.skyMesh.position.z = scrollZ;
        if (this.skyPhotoMesh) this.skyPhotoMesh.position.z = scrollZ;
        if (this.sunHalo) {
            // 太陽ハローもスクロールに追従、常に sunDir の方向
            const sd = this.skyMesh && this.skyMesh.material.uniforms
                ? this.skyMesh.material.uniforms.sunDir.value
                : null;
            if (sd) {
                this.sunHalo.position.set(sd.x * 150, sd.y * 150, scrollZ + sd.z * 150);
                this.sunHalo.lookAt(0, this.sunHalo.position.y * 0.5, scrollZ);
            }
        }
        if (this.rutMeshes) {
            this.rutMeshes.forEach(r => r.position.z = scrollZ);
        }
        if (this.pebbleMeshes) {
            this.pebbleMeshes.forEach(p => {
                const relZ = p.mesh.position.z - scrollZ;
                if (relZ < -50) p.mesh.position.z += 90;
                else if (relZ > 50) p.mesh.position.z -= 90;
            });
        }
        if (this.trackDots) {
            this.trackDots.forEach(t => {
                const relZ = t.mesh.position.z - scrollZ;
                if (relZ < -50) t.mesh.position.z += 100;
                else if (relZ > 50) t.mesh.position.z -= 100;
            });
        }
        if (this.farSilhouettes) {
            this.farSilhouettes.forEach(s => {
                if (s.lateralRow) {
                    // 横方向の遠景は scrollZ にゆるく追従
                    s.mesh.position.z = s.baseZOffset + scrollZ * (1 - s.parallax);
                } else {
                    // 前後の遠景: 指定オフセットに scrollZ を加算
                    s.mesh.position.z = s.baseZOffset + scrollZ;
                }
            });
        }
        if (this.heatShimmers) {
            this.heatShimmers.forEach(s => {
                s.phase += dt * s.speed;
                s.mesh.position.y = s.baseY + Math.sin(s.phase) * s.amp;
                const offsetY = Math.sin(s.phase * 1.5) * 0.05;
                s.mesh.scale.set(1 + offsetY, 1, 1);
                // スクロールに追従してラップ
                const relZ = s.mesh.position.z - scrollZ;
                if (relZ < -45) s.mesh.position.z += 90;
                else if (relZ > 45) s.mesh.position.z -= 90;
            });
        }
        if (this.sandDrift) {
            this.sandDrift.forEach(g => {
                g.phase += dt * 2.0;
                g.mesh.position.x += g.vx * dt;
                g.mesh.position.y += Math.sin(g.phase) * g.bobAmp * dt + g.vy * dt;
                if (g.mesh.position.x > 35) g.mesh.position.x = -35;
                if (g.mesh.position.y < 0.1) g.mesh.position.y = 2.0;
                if (g.mesh.position.y > 2.5) g.mesh.position.y = 0.2;
                const relZ = g.mesh.position.z - scrollZ;
                if (relZ < -40) g.mesh.position.z += 80;
                else if (relZ > 40) g.mesh.position.z -= 80;
            });
        }

        if (this.photoForegroundMeshes.length > 0) {
            this.photoForegroundMeshes.forEach((entry) => {
                entry.mesh.position.z = scrollZ + (entry.zOffset || 0);
            });
        }

        // 雲は横 (X) 方向へゆっくり drift、Z 方向へはプレイヤーの前後でラップ
        this.clouds.forEach(c => {
            c.group.position.x += c.speed * dt * 0.5;
            if (c.group.position.z > scrollZ + 90) c.group.position.z -= 180;
            else if (c.group.position.z < scrollZ - 90) c.group.position.z += 180;
        });

        // パララックス背景: +Z 方向へラップ
        this.bgLayers.forEach(layer => {
            layer.objects.forEach(obj => {
                const relZ = obj.position.z - scrollZ * layer.parallaxRate;
                if (relZ < -90) obj.position.z += 180;
                else if (relZ > 90) obj.position.z -= 180;
            });
        });

        // ダイナミックプロップのアニメーション
        // 後半の要塞ギミックは見た目の密度が高いので、数が多い時は分散更新して
        // 1フレーム内の transform/material 更新数を抑える。
        this._dynamicFrame = (this._dynamicFrame || 0) + 1;
        const dynamicStride = this.dynamicProps.length > 24 ? 3 : (this.dynamicProps.length > 14 ? 2 : 1);
        // 距離カリング: スクロール窓から十分離れたプロップは更新スキップ。
        // viewRange=60 / cleanupRange=28 なので、|Δz|>50 はほぼ画面外。
        // time だけ進めて将来カメラが戻った時にアニメ位相が破綻しないようにする。
        const DYNAMIC_CULL_DZ = 50;
        for (let i = this.dynamicProps.length - 1; i >= 0; i--) {
            const p = this.dynamicProps[i];
            p.time += dt;
            if (p.host && Math.abs(p.host.position.z - scrollZ) > DYNAMIC_CULL_DZ) continue;
            if (dynamicStride > 1 && ((i + this._dynamicFrame) % dynamicStride) !== 0) continue;
            switch (p.type) {
                case 'derrick': {
                    // 炎: 上下に揺らぎ、明滅
                    p.flameLayers.forEach((f, idx) => {
                        const flick = 0.85 + Math.sin(p.time * (8 + idx * 1.3) + idx) * 0.25 + (Math.random() - 0.5) * 0.15;
                        f.scale.set(flick, 0.85 + Math.cos(p.time * 6 + idx) * 0.20, flick);
                        f.rotation.y = Math.sin(p.time * 4 + idx) * 0.15;
                    });
                    p.smokePuffs.forEach((s, idx) => {
                        s.phase += dt * 0.6;
                        s.mesh.position.y = s.baseY + Math.sin(s.phase) * 0.4 + p.time * 0.3 % 2;
                        s.mesh.position.x = Math.sin(s.phase * 0.5 + idx) * 0.5;
                        const sc = 1.0 + Math.sin(s.phase) * 0.15;
                        s.mesh.scale.set(sc, sc, sc);
                    });
                    break;
                }
                case 'smokestack': {
                    p.smokePuffs.forEach((s, idx) => {
                        s.phase += dt * 0.5;
                        s.mesh.position.y = s.baseY + (p.time * 0.4 + idx * 0.3) % 1.5;
                        s.mesh.position.x = Math.sin(s.phase) * 0.4;
                        const sc = 1.0 + Math.sin(s.phase) * 0.12;
                        s.mesh.scale.set(sc, sc, sc);
                    });
                    break;
                }
                case 'crane': {
                    // 鎖が左右にゆっくり揺れる
                    p.chainGroup.rotation.x = Math.sin(p.time * 0.8) * 0.18;
                    p.chainGroup.rotation.z = Math.cos(p.time * 0.6) * 0.10;
                    break;
                }
                case 'wreck': {
                    p.smokePuffs.forEach((s, idx) => {
                        s.phase += dt * 0.7;
                        s.mesh.position.y = s.baseY + Math.sin(s.phase) * 0.25 + (p.time * 0.3 + idx) % 1.0;
                        s.mesh.position.x = 0.3 + Math.sin(s.phase * 0.5) * 0.3;
                    });
                    if (p.ember) {
                        // 残り火の明滅
                        const f = 0.8 + Math.sin(p.time * 12) * 0.4 + Math.random() * 0.2;
                        p.ember.scale.set(f, f, f);
                    }
                    break;
                }
                case 'aagun': {
                    // 砲塔がゆっくり左右へ旋回（不気味な索敵）
                    p.gunGroup.rotation.y = Math.sin(p.time * 0.4) * 0.6;
                    break;
                }
                case 'banner': {
                    // 旗のセグメントが順次波打つ
                    p.segs.forEach((seg, idx) => {
                        seg.rotation.x = Math.sin(p.time * 2.5 + idx * 0.8) * 0.18;
                        seg.position.z = Math.sin(p.time * 2.5 + idx * 0.8) * 0.06;
                    });
                    p.flagGroup.rotation.y = Math.sin(p.time * 0.6) * 0.05;
                    break;
                }
                case 'searchlight': {
                    // ゆっくり旋回
                    p.lightGroup.rotation.y = p.time * 0.6;
                    break;
                }
                case 'steam': {
                    // 蒸気が右方向へ流れて消えていく
                    p.steamPuffs.forEach((s, idx) => {
                        s.phase += dt * 1.5;
                        const t = (p.time * 0.6 + idx * 0.25) % 1.5;
                        s.mesh.position.x = s.basePos.x + t * 1.2;
                        s.mesh.position.y = s.basePos.y + Math.sin(s.phase) * 0.2 + t * 0.3;
                        const fade = Math.max(0, 1 - t / 1.5);
                        s.mesh.material.opacity = fade * 0.55;
                        const sc = 1.0 + t * 1.5;
                        s.mesh.scale.set(sc, sc, sc);
                    });
                    break;
                }
                case 'fortress_gate': {
                    const spread = 0.12 + (Math.sin(p.time * 0.9) * 0.5 + 0.5) * 0.55;
                    p.leftDoor.position.z = -spread;
                    p.rightDoor.position.z = spread;
                    const blink = Math.max(0.25, Math.sin(p.time * 9) * 0.5 + 0.5);
                    p.lampMats.forEach((m, idx) => {
                        m.opacity = idx % 2 === 0 ? blink : (1 - blink * 0.75);
                    });
                    break;
                }
                case 'radar': {
                    p.radarGroup.rotation.y += dt * 1.5;
                    const pulse = Math.max(0.2, Math.sin(p.time * 5.5) * 0.5 + 0.5);
                    p.beaconMats.forEach((m, idx) => {
                        const phase = idx === 0 ? pulse : (1 - pulse * 0.8);
                        m.opacity = phase;
                    });
                    break;
                }
                case 'siren': {
                    p.headGroup.rotation.y += dt * 1.8;
                    const pulse = Math.max(0.2, Math.sin(p.time * 8.5) * 0.5 + 0.5);
                    p.lampMats.forEach((m, idx) => {
                        const ph = idx === 0 ? pulse : (1 - pulse * 0.75);
                        m.core.emissiveIntensity = 0.25 + ph * 0.8;
                        m.glow.opacity = 0.15 + ph * 0.55;
                    });
                    break;
                }
                case 'mega_cannon': {
                    p.turretGroup.rotation.y = Math.sin(p.time * 0.48) * 0.75;
                    p.barrelGroup.position.x = 0.75 - Math.max(0, Math.sin(p.time * 2.6)) * 0.12;
                    const blink = Math.max(0.18, Math.sin(p.time * 8.0) * 0.5 + 0.5);
                    p.lampMats.forEach((m, idx) => {
                        m.opacity = idx % 2 === 0 ? blink : (1 - blink * 0.65);
                    });
                    break;
                }
                case 'shield_generator': {
                    p.rings.forEach((ring, idx) => {
                        ring.rotation.z += dt * (0.7 + idx * 0.35) * (idx % 2 ? -1 : 1);
                        const sc = 1 + Math.sin(p.time * 2.0 + idx) * 0.04;
                        ring.scale.set(sc, sc, sc);
                    });
                    const pulse = Math.max(0.25, Math.sin(p.time * 4.0) * 0.5 + 0.5);
                    p.core.scale.setScalar(0.85 + pulse * 0.45);
                    p.coreMat.opacity = 0.45 + pulse * 0.35;
                    p.shield.scale.set(1.0 + pulse * 0.08, 0.78 + pulse * 0.05, 1.0 + pulse * 0.08);
                    p.shieldMat.opacity = 0.06 + pulse * 0.12;
                    break;
                }
                case 'missile_silo': {
                    const open = Math.max(0, Math.sin(p.time * 0.9)) * 0.42;
                    p.hatches.forEach(h => {
                        h.mesh.position.x = h.baseX + h.side * open;
                    });
                    p.missileGroups.forEach(m => {
                        const lift = Math.max(0, Math.sin(p.time * 0.9 + m.phase)) * 0.35;
                        m.group.position.y = m.baseY + lift;
                    });
                    const blink = Math.max(0.18, Math.sin(p.time * 7.5) * 0.5 + 0.5);
                    p.beaconMats.forEach((m, idx) => {
                        m.opacity = idx % 2 === 0 ? blink : (1 - blink * 0.65);
                    });
                    break;
                }
            }
        }

        // チャンク生成（前方 +Z）
        while (this.lastChunkZ < scrollZ + this.viewRange) {
            this._generateChunk(this.lastChunkZ + this.chunkSize);
        }

        // チャンク削除（後方 -Z）
        // 1 フレームあたり maxChunkDisposesPerFrame 個までに制限し、解放コストを分散する。
        // 残ったチャンクは次フレーム以降に処理されるため、メモリ蓄積は数フレーム遅延するだけ。
        // メモリプレッシャー検出時は main.js から _memPressureBoost が立ち、その分だけ追加で dispose する。
        let disposedThisFrame = 0;
        let frameLimit = this.maxChunkDisposesPerFrame;
        if (this._memPressureBoost && this._memPressureBoost > 0) {
            frameLimit += this._memPressureBoost;
            this._memPressureBoost = 0;
        }
        for (let i = this.chunks.length - 1; i >= 0; i--) {
            if (disposedThisFrame >= frameLimit) break;
            const chunk = this.chunks[i];
            if (chunk.startZ + this.chunkSize < scrollZ - this.cleanupRange) {
                chunk.objects.forEach(obj => {
                    this.scene.remove(obj);
                    // 関連するダイナミックプロップを除去（子孫も走査）
                    obj.traverse(child => {
                        if (child.userData && child.userData.dynamicRef) {
                            const idx = this.dynamicProps.indexOf(child.userData.dynamicRef);
                            if (idx >= 0) this.dynamicProps.splice(idx, 1);
                        }
                        if (child.isMesh) {
                            const g = child.geometry;
                            if (g && !(g.userData && g.userData.shared)) g.dispose();
                            const mat = child.material;
                            if (mat && mat.dispose && !(mat.userData && mat.userData.shared)) mat.dispose();
                        }
                    });
                });
                this.chunks.splice(i, 1);
                disposedThisFrame++;
                this._obstacleCacheDirty = true;
            }
        }

        // ダイナミックプロップ上限（防衛的）— 想定外の蓄積を防ぐ
        // 各プロップの mesh 参照は破棄済み chunk と共に既に dispose されているので
        // ここでは配列から外すのみで安全。
        const endgamePhase = this._getEndgamePhase(scrollZ);
        const MAX_DYNAMIC_PROPS = endgamePhase >= 0 ? 18 : (this._isFinalStage(scrollZ) ? 24 : 32);
        if (this.dynamicProps.length > MAX_DYNAMIC_PROPS) {
            this.dynamicProps.splice(0, this.dynamicProps.length - MAX_DYNAMIC_PROPS);
        }
    }

    // ============================================
    // STREET-SCAPE PROP BUILDERS
    // ============================================

    /** 高床式監視櫓: 4本の木柱 + プラットフォーム + 茅葺き屋根 */
    _buildStiltWatchtower(group) {
        const woodMat   = _sharedMat('stilt_wood',   () => new THREE.MeshStandardMaterial({ color: 0x6B4A2A, roughness: 0.9 }));
        const darkWood  = _sharedMat('stilt_dark',   () => new THREE.MeshStandardMaterial({ color: 0x4A331E, roughness: 0.92 }));
        const thatchMat = _sharedMat('stilt_thatch', () => new THREE.MeshStandardMaterial({ color: 0xC79858, roughness: 0.95, flatShading: true }));
        const railMat   = _sharedMat('stilt_rail',   () => new THREE.MeshStandardMaterial({ color: 0x5C3A20, roughness: 0.92 }));

        // 4本の傾いた支柱
        for (let i = 0; i < 4; i++) {
            const sx = (i % 2 === 0) ? -1 : 1;
            const sz = (i < 2) ? -1 : 1;
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 4.6, 6), woodMat);
            post.position.set(sx * 1.0, 2.3, sz * 1.0);
            post.rotation.z = sx * 0.06;
            post.rotation.x = sz * 0.06;
            group.add(post);
        }
        // クロスブレース
        for (let i = 0; i < 2; i++) {
            const brace = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 2.5), darkWood);
            brace.position.set(i === 0 ? -1.0 : 1.0, 1.4, 0);
            brace.rotation.x = Math.PI / 4 * (i === 0 ? 1 : -1);
            group.add(brace);
        }
        // プラットフォーム床
        const floor = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 2.6), woodMat);
        floor.position.y = 4.55;
        group.add(floor);
        // 床板の縞
        for (let i = -1; i <= 1; i++) {
            const plank = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.05, 0.25), darkWood);
            plank.position.set(0, 4.66, i * 0.7);
            group.add(plank);
        }
        // 手摺
        for (let s of [-1, 1]) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.05, 0.05), railMat);
            rail.position.set(0, 5.15, s * 1.25);
            group.add(rail);
            for (let i = -1; i <= 1; i++) {
                const post2 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 0.06), railMat);
                post2.position.set(i * 1.1, 4.85, s * 1.25);
                group.add(post2);
            }
        }
        // 茅葺き円錐屋根（4面）
        const roof = new THREE.Mesh(new THREE.ConeGeometry(2.2, 1.6, 4), thatchMat);
        roof.position.y = 5.95;
        roof.rotation.y = Math.PI / 4;
        group.add(roof);
        // 屋根の毛羽（雰囲気）
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 4), thatchMat);
            tuft.position.set(Math.cos(a) * 1.7, 5.45, Math.sin(a) * 1.7);
            tuft.rotation.z = Math.cos(a) * 0.25;
            tuft.rotation.x = Math.sin(a) * 0.25;
            group.add(tuft);
        }
        // 梯子
        const ladderRail = _sharedMat('stilt_ladder', () => new THREE.MeshStandardMaterial({ color: 0x5A3818, roughness: 0.9 }));
        for (let s of [-1, 1]) {
            const r = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 4.6, 5), ladderRail);
            r.position.set(s * 0.2, 2.3, -1.4);
            r.rotation.x = -0.25;
            group.add(r);
        }
        for (let i = 0; i < 8; i++) {
            const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.45, 4), ladderRail);
            rung.position.set(0, 0.3 + i * 0.55, -1.4 - i * 0.13);
            rung.rotation.z = Math.PI / 2;
            group.add(rung);
        }
        return group;
    }

    /** オイルドラム集積（赤色・爆発物） */
    _buildOilDrumRack(group) {
        const palletMat = _sharedMat('oildrum_pallet', () => new THREE.MeshStandardMaterial({ color: 0x6B4A2A, roughness: 0.92 }));
        const drumColors = [0xC23022, 0xA82A1F, 0xD0381E, 0x8E2418];
        const bandMat = _sharedMat('oildrum_band', () => new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.8 }));
        const warnMat = _sharedMat('oildrum_warn', () => new THREE.MeshBasicMaterial({ color: 0xFFCC22 }));
        // 木製パレット
        const pallet = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 1.4), palletMat);
        pallet.position.y = 0.09;
        group.add(pallet);
        // ドラム缶 6 本（3列 x 2列）
        const positions = [
            [-0.85, -0.42], [0, -0.42], [0.85, -0.42],
            [-0.85,  0.42], [0,  0.42], [0.85,  0.42],
        ];
        positions.forEach(([px, pz], i) => {
            const drumMat = _sharedMat('oildrum_' + (i % drumColors.length), () => new THREE.MeshStandardMaterial({
                color: drumColors[i % drumColors.length],
                roughness: 0.55, metalness: 0.6,
                emissive: 0x220a05, emissiveIntensity: 0.18,
            }));
            const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.3, 12), drumMat);
            drum.position.set(px, 0.83, pz);
            group.add(drum);
            // 帯
            const band = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.03, 4, 14), bandMat);
            band.rotation.x = Math.PI / 2;
            band.position.set(px, 0.83, pz);
            group.add(band);
            // 引火マーク（黄色三角）
            const warn = new THREE.Mesh(new THREE.CircleGeometry(0.12, 3), warnMat);
            warn.position.set(px, 0.95, pz + 0.43);
            group.add(warn);
        });
        return group;
    }

    /** スクラップ金属の山 */
    _buildScrapMetalPile(group) {
        const rustyMats = [
            _sharedMat('scrap_0', () => new THREE.MeshStandardMaterial({ color: 0x6E4329, roughness: 0.95, metalness: 0.4 })),
            _sharedMat('scrap_1', () => new THREE.MeshStandardMaterial({ color: 0x5B3A24, roughness: 0.92, metalness: 0.5 })),
            _sharedMat('scrap_2', () => new THREE.MeshStandardMaterial({ color: 0x3F2A1C, roughness: 0.88, metalness: 0.6 })),
            _sharedMat('scrap_3', () => new THREE.MeshStandardMaterial({ color: 0x8B5A2B, roughness: 0.9, metalness: 0.45 })),
        ];
        // ベースの山
        const base = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.6, 7), rustyMats[1]);
        base.position.y = 0.3;
        group.add(base);
        // 散らばった鉄板/パイプ
        for (let i = 0; i < 14; i++) {
            const m = rustyMats[i % rustyMats.length];
            const isPipe = Math.random() < 0.35;
            const piece = isPipe
                ? new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.6 + Math.random() * 0.7, 6), m)
                : new THREE.Mesh(new THREE.BoxGeometry(0.4 + Math.random() * 0.6, 0.08 + Math.random() * 0.18, 0.3 + Math.random() * 0.5), m);
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * 1.0;
            piece.position.set(Math.cos(a) * r, 0.4 + Math.random() * 0.7, Math.sin(a) * r);
            piece.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
            group.add(piece);
        }
        // 上に突き出す鉄骨
        const beam = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.6, 0.18), rustyMats[2]);
        beam.position.set(0.2, 1.1, -0.1);
        beam.rotation.z = 0.4;
        group.add(beam);
        return group;
    }

    /** 廃棄ジープ（コンセプト 0bSNIrGdkOIk の軍用車両） */
    _buildWreckedJeep(group) {
        const bodyMat = _sharedMat('jeep_body',  () => new THREE.MeshStandardMaterial({ color: 0x4A5A3A, roughness: 0.88, metalness: 0.4 }));
        const dark    = _sharedMat('jeep_dark',  () => new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.85 }));
        const rust    = _sharedMat('jeep_rust',  () => new THREE.MeshStandardMaterial({ color: 0x6B3A20, roughness: 0.95, metalness: 0.3 }));
        const glassMat= _sharedMat('jeep_glass', () => new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.3, metalness: 0.4, transparent: true, opacity: 0.6 }));

        // 車体（傾けて廃棄感を出す）
        const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.7, 1.3), bodyMat);
        body.position.set(0, 0.55, 0);
        group.add(body);
        // ボンネット
        const hood = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.5, 1.2), bodyMat);
        hood.position.set(1.2, 0.45, 0);
        group.add(hood);
        // 後部
        const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.85, 1.25), rust);
        trunk.position.set(-1.0, 0.55, 0);
        group.add(trunk);
        // フロントガラス
        const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.55, 1.1), glassMat);
        windshield.position.set(0.65, 1.05, 0);
        windshield.rotation.z = -0.3;
        group.add(windshield);
        // 4輪（やや潰れた）
        const wheelMat = dark;
        const wheelPositions = [[1.05, -0.6], [1.05, 0.6], [-1.05, -0.6], [-1.05, 0.6]];
        wheelPositions.forEach(([wx, wz], i) => {
            const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.22, 12), wheelMat);
            wheel.rotation.x = Math.PI / 2;
            wheel.position.set(wx, 0.32 - (i === 1 ? 0.1 : 0), wz);
            group.add(wheel);
        });
        // 焦げた残骸エンジン
        const engine = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 0.9), dark);
        engine.position.set(1.2, 0.8, 0);
        group.add(engine);
        // 煙突き残骸
        const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 5), dark);
        stack.position.set(1.4, 1.05, 0.4);
        group.add(stack);
        // 全体に焦げ感のため全体を少し傾ける
        group.rotation.z = -0.06;
        return group;
    }

    /** 弾薬箱の山積み */
    _buildAmmoCrateStack(group) {
        const woodMat    = _sharedMat('ammo_wood',    () => new THREE.MeshStandardMaterial({ color: 0x6E5034, roughness: 0.92 }));
        const dark       = _sharedMat('ammo_dark',    () => new THREE.MeshStandardMaterial({ color: 0x4A3422, roughness: 0.92 }));
        const stencilMat = _sharedMat('ammo_stencil', () => new THREE.MeshBasicMaterial({ color: 0xD0BC78 }));
        // 下段 2 個
        for (let i = -1; i <= 1; i += 2) {
            const c = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.55, 0.65), woodMat);
            c.position.set(i * 0.5, 0.28, 0);
            c.rotation.y = (Math.random() - 0.5) * 0.2;
            group.add(c);
            // 補強帯
            const strip = new THREE.Mesh(new THREE.BoxGeometry(0.97, 0.07, 0.67), dark);
            strip.position.copy(c.position);
            strip.position.y = 0.28;
            strip.rotation.copy(c.rotation);
            group.add(strip);
            // ステンシル（マーク）
            const mark = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.18), stencilMat);
            mark.position.set(c.position.x, 0.4, 0.34);
            mark.rotation.copy(c.rotation);
            group.add(mark);
        }
        // 上段 1 個（ずれて）
        const top = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.55, 0.65), woodMat);
        top.position.set(-0.1, 0.83, -0.05);
        top.rotation.y = 0.2;
        group.add(top);
        const topStrip = new THREE.Mesh(new THREE.BoxGeometry(0.97, 0.07, 0.67), dark);
        topStrip.position.copy(top.position);
        topStrip.rotation.copy(top.rotation);
        group.add(topStrip);
        const topMark = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.18), stencilMat);
        topMark.position.set(-0.1, 0.93, 0.3);
        topMark.rotation.copy(top.rotation);
        group.add(topMark);
        return group;
    }

    /** 軍用標識ポスト（複数の方向矢印） */
    _buildMilitarySignpost(group) {
        const postMat = _sharedMat('signpost_post', () => new THREE.MeshStandardMaterial({ color: 0x5A3A20, roughness: 0.92 }));
        const baseMat = _sharedMat('signpost_base', () => new THREE.MeshStandardMaterial({ color: 0x3A2810, roughness: 0.9 }));
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 2.6, 6), postMat);
        post.position.y = 1.3;
        group.add(post);
        const arrowColors = [0x8B2A20, 0x5A6A3A, 0x2A4060, 0xAA8830];
        const labels = 4;
        for (let i = 0; i < labels; i++) {
            const arrowMat = _sharedMat('signpost_arrow_' + (i % arrowColors.length),
                () => new THREE.MeshStandardMaterial({ color: arrowColors[i % arrowColors.length], roughness: 0.85 }));
            const arrow = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.28, 0.05), arrowMat);
            const yawDir = (i / labels) * Math.PI * 2 + Math.random() * 0.2;
            arrow.position.set(Math.cos(yawDir) * 0.42, 1.4 + i * 0.32, Math.sin(yawDir) * 0.42);
            arrow.rotation.y = yawDir;
            group.add(arrow);
            // 矢じり
            const tip = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.28, 3), arrowMat);
            tip.rotation.z = -Math.PI / 2;
            tip.position.set(Math.cos(yawDir) * 0.95, 1.4 + i * 0.32, Math.sin(yawDir) * 0.95);
            tip.rotation.y = yawDir;
            group.add(tip);
        }
        // ポスト基部
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.18, 8), baseMat);
        base.position.y = 0.09;
        group.add(base);
        return group;
    }

    /** 無線アンテナ */
    _buildRadioAntenna(group) {
        const metalMat = _sharedMat('antenna_metal', () => new THREE.MeshStandardMaterial({ color: 0x707880, roughness: 0.6, metalness: 0.7 }));
        const wireMat  = _sharedMat('antenna_wire',  () => new THREE.MeshBasicMaterial({ color: 0x222222 }));
        const baseMat  = _sharedMat('antenna_base',  () => new THREE.MeshStandardMaterial({ color: 0x4A4A50, roughness: 0.85 }));
        const dishMat  = _sharedMat('antenna_dish',  () => new THREE.MeshStandardMaterial({ color: 0xCFCFCF, roughness: 0.45, metalness: 0.7 }));
        const lampMat  = _sharedMat('antenna_lamp',  () => new THREE.MeshBasicMaterial({ color: 0xFF3322 }));
        // ベース
        const base = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.4, 1.4), baseMat);
        base.position.y = 0.2;
        group.add(base);
        // タワー本体（4本柱 + クロスブレース）
        const towerH = 5.2;
        for (let i = 0; i < 4; i++) {
            const sx = (i % 2 === 0) ? -1 : 1;
            const sz = (i < 2) ? -1 : 1;
            const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, towerH, 4), metalMat);
            leg.position.set(sx * 0.4, 0.4 + towerH / 2, sz * 0.4);
            leg.rotation.z = sx * 0.04;
            leg.rotation.x = sz * 0.04;
            group.add(leg);
        }
        // ジグザグの斜材
        for (let h = 0; h < 5; h++) {
            const y = 0.6 + h * 0.95;
            for (let s = 0; s < 4; s++) {
                const a1 = (s / 4) * Math.PI * 2;
                const a2 = ((s + 1) / 4) * Math.PI * 2;
                const x1 = Math.cos(a1) * 0.42, z1 = Math.sin(a1) * 0.42;
                const x2 = Math.cos(a2) * 0.42, z2 = Math.sin(a2) * 0.42;
                const len = Math.hypot(x2 - x1, 0.5, z2 - z1);
                const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, len, 3), metalMat);
                brace.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
                brace.lookAt(x2, y + 0.5, z2);
                brace.rotateX(Math.PI / 2);
                group.add(brace);
            }
        }
        // 上部のお皿アンテナ
        const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.05, 0.18, 12), dishMat);
        dish.position.y = towerH + 0.6;
        dish.rotation.z = -0.4;
        group.add(dish);
        // 細長スパイク
        const spike = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.2, 4), metalMat);
        spike.position.y = towerH + 1.2;
        group.add(spike);
        // 赤い航空灯
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 5), lampMat);
        lamp.position.y = towerH + 1.85;
        group.add(lamp);
        // ガイワイヤ（装飾）
        for (let s of [-1, 1]) {
            const w = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 5.5, 3), wireMat);
            w.position.set(s * 1.2, 2.0, 0);
            w.rotation.z = s * Math.PI / 6;
            group.add(w);
        }
        return group;
    }
}
