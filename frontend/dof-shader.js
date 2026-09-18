// dof-shader.js — Depth-of-Field Fragment-Shader für PostProcessStage.
// Single-pass, 13 taps, depth-aware. Linearisiert czm_readDepth via inverse projection.
// Eingebunden vor views.js. Stellt window.__MIB_DOF_FRAG bereit.

window.__MIB_DOF_FRAG = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform float focusDistance;
uniform float focusRange;
uniform float bokehStrength;
uniform float maxBlur;
in vec2 v_textureCoordinates;

float linearEyeDepth(vec2 uv) {
    float d = czm_readDepth(depthTexture, uv);
    vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 eye = czm_inverseProjection * ndc;
    return -eye.z / eye.w;
}

void main() {
    float z = linearEyeDepth(v_textureCoordinates);
    float halfRange = max(focusRange * 0.5, 0.001);
    float coc = clamp((abs(z - focusDistance) - halfRange) / max(focusRange, 0.001), 0.0, 1.0);
    float radius = coc * bokehStrength * maxBlur;

    vec2 px = radius / czm_viewport.zw;
    vec3 acc = texture(colorTexture, v_textureCoordinates).rgb * 0.20;

    vec2 K0  = vec2( 1.0,  0.0);
    vec2 K1  = vec2( 0.5,  0.87);
    vec2 K2  = vec2(-0.5,  0.87);
    vec2 K3  = vec2(-1.0,  0.0);
    vec2 K4  = vec2(-0.5, -0.87);
    vec2 K5  = vec2( 0.5, -0.87);
    vec2 K6  = vec2( 0.7,  0.7);
    vec2 K7  = vec2(-0.7,  0.7);
    vec2 K8  = vec2(-0.7, -0.7);
    vec2 K9  = vec2( 0.7, -0.7);
    vec2 K10 = vec2( 0.0,  1.0);
    vec2 K11 = vec2( 0.0, -1.0);

    float w = 0.80 / 12.0;
    acc += texture(colorTexture, v_textureCoordinates + K0  * px).rgb * w;
    acc += texture(colorTexture, v_textureCoordinates + K1  * px).rgb * w;
    acc += texture(colorTexture, v_textureCoordinates + K2  * px).rgb * w;
    acc += texture(colorTexture, v_textureCoordinates + K3  * px).rgb * w;
    acc += texture(colorTexture, v_textureCoordinates + K4  * px).rgb * w;
    acc += texture(colorTexture, v_textureCoordinates + K5  * px).rgb * w;
    acc += texture(colorTexture, v_textureCoordinates + K6  * px).rgb * w;
    acc += texture(colorTexture, v_textureCoordinates + K7  * px).rgb * w;
    acc += texture(colorTexture, v_textureCoordinates + K8  * px).rgb * w;
    acc += texture(colorTexture, v_textureCoordinates + K9  * px).rgb * w;
    acc += texture(colorTexture, v_textureCoordinates + K10 * px).rgb * w;
    acc += texture(colorTexture, v_textureCoordinates + K11 * px).rgb * w;

    out_FragColor = vec4(acc, 1.0);
}
`;
