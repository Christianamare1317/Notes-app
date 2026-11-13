import math
import struct
import zlib

def make_png(width, height, rgba_bytes):
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xffffffff
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', crc)
    
    raw = bytearray()
    row_len = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(rgba_bytes[y * row_len : (y + 1) * row_len])
    idat = zlib.compress(bytes(raw), 9)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')

def make_ico(png_dict):
    count = len(png_dict)
    header = struct.pack('<HHH', 0, 1, count)
    entries = bytearray()
    offset = 6 + count * 16
    for sz, data in png_dict.items():
        w = sz if sz < 256 else 0
        h = sz if sz < 256 else 0
        entries.extend(struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    return header + bytes(entries) + b''.join(png_dict.values())

def clamp(val, low=0.0, high=1.0):
    return max(low, min(high, val))

def lerp(c1, c2, t):
    t = clamp(t)
    return [c1[i] + (c2[i] - c1[i]) * t for i in range(len(c1))]

def dist_rounded_rect(px, py, x0, y0, x1, y1, r):
    cx = clamp(px, x0 + r, x1 - r)
    cy = clamp(py, y0 + r, y1 - r)
    return math.hypot(px - cx, py - cy) - r

def sample_point(u, v):
    # Coordinate system: 0..64 x 0..64
    px = u * 64.0
    py = v * 64.0

    # 1. Base Squircle (Tile)
    d_tile = dist_rounded_rect(px, py, 2.0, 2.0, 62.0, 62.0, 15.0)
    if d_tile > 0.5:
        return [0, 0, 0, 0] # Transparent

    tile_alpha = clamp(0.5 - d_tile)

    # Base gradient: #6366F1 -> #4F46E5 -> #3730A3
    diag_t = (px * 0.7 + py * 1.0) / 108.0
    if diag_t < 0.5:
        base_col = lerp([99, 102, 241], [79, 70, 229], diag_t * 2.0)
    else:
        base_col = lerp([79, 70, 229], [55, 48, 163], (diag_t - 0.5) * 2.0)

    # Subtle top sheen
    if py < 28.0:
        sheen_d = ((px - 32.0) / 30.0)**2 + ((py - 6.0) / 22.0)**2
        if sheen_d < 1.0:
            sheen_amt = (1.0 - sheen_d) * 0.16
            base_col = lerp(base_col, [255, 255, 255], sheen_amt)

    # Inset edge border
    if abs(d_tile) < 1.2:
        edge_amt = (1.2 - abs(d_tile)) / 1.2 * 0.28
        base_col = lerp(base_col, [255, 255, 255], edge_amt)

    pixel_rgb = base_col
    pixel_a = tile_alpha

    # 2. Paper Sheet
    # Box [17..48, 12..53], bottom corners rounded r=3.5, top-left r=2.5
    d_paper = dist_rounded_rect(px, py, 17.0, 12.0, 48.0, 53.0, 3.5)
    
    # Dog-ear fold cut: ONLY in top-right corner (px >= 36.0 and py <= 24.0)
    # The fold diagonal is px - py = 24.0. Points with px - py > 24.0 are cut out.
    in_corner = (px >= 36.0 and py <= 24.0)
    d_fold_cut = (px - py) - 24.0 # > 0 means inside the cut-off triangle

    in_paper = (d_paper <= 0.0)
    if in_corner and d_fold_cut > 0.0:
        in_paper = False

    paper_mask = 0.0
    if in_paper:
        if in_corner:
            paper_mask = clamp(0.5 - max(d_paper, d_fold_cut / 1.414))
        else:
            paper_mask = clamp(0.5 - d_paper)
    elif d_paper <= 0.5:
        if in_corner:
            paper_mask = clamp(0.5 - max(d_paper, d_fold_cut / 1.414))
        else:
            paper_mask = clamp(0.5 - d_paper)

    if paper_mask > 0.0:
        # Paper subtle vertical gradient #FFFFFF to #F1F5F9
        paper_t = (py - 12.0) / 41.0
        paper_col = lerp([255, 255, 255], [241, 245, 249], paper_t)
        
        # Note Lines:
        # Line 1: Accent Indigo Title Bar [21..32, 19.5..23]
        d_l1 = dist_rounded_rect(px, py, 21.0, 19.5, 32.0, 23.0, 1.75)
        if d_l1 < 0.5:
            m_l1 = clamp(0.5 - d_l1)
            paper_col = lerp(paper_col, [79, 70, 229], m_l1)

        # Line 2: [21..44, 27..30]
        d_l2 = dist_rounded_rect(px, py, 21.0, 27.0, 44.0, 30.0, 1.5)
        if d_l2 < 0.5:
            m_l2 = clamp(0.5 - d_l2)
            paper_col = lerp(paper_col, [148, 163, 184], m_l2)

        # Line 3: [21..39, 34..37]
        d_l3 = dist_rounded_rect(px, py, 21.0, 34.0, 39.0, 37.0, 1.5)
        if d_l3 < 0.5:
            m_l3 = clamp(0.5 - d_l3)
            paper_col = lerp(paper_col, [203, 213, 225], m_l3)

        # Checkpoint bullet: circle at (22.5, 42.5), radius 1.8
        d_dot = math.hypot(px - 22.5, py - 42.5) - 1.8
        if d_dot < 0.5:
            m_dot = clamp(0.5 - d_dot)
            paper_col = lerp(paper_col, [245, 158, 11], m_dot)

        # Line 4 (after bullet): [26.5..36.0, 41.0..44.0]
        d_l4 = dist_rounded_rect(px, py, 26.5, 41.0, 36.0, 44.0, 1.5)
        if d_l4 < 0.5:
            m_l4 = clamp(0.5 - d_l4)
            paper_col = lerp(paper_col, [203, 213, 225], m_l4)

        pixel_rgb = lerp(pixel_rgb, paper_col, paper_mask)

    # 3. Golden Fold Flap
    # The flap triangle has vertices (36, 12), (48, 24), and (36, 24)
    # Bound: 36 <= px <= 48, 12 <= py <= 24, and px - py <= 24
    if px >= 35.5 and px <= 48.5 and py >= 11.5 and py <= 24.5:
        # Distance to diagonal: (24.0 - (px - py)) / 1.414
        d_hypot = 24.0 - (px - py) # > 0 is inside the flap side
        d_left = px - 36.0         # > 0 is right of left edge
        d_bottom = 24.0 - py       # > 0 is above bottom edge

        # Check distance to flap interior
        d_flap = min(d_hypot / 1.414, min(d_left, d_bottom))
        
        # Soft rounded corner at apex (36, 24)
        corner_d = math.hypot(px - 36.0, py - 24.0)
        if px <= 38.0 and py >= 22.0 and corner_d > 4.0:
            d_flap = -1.0 # smooth rounding
        
        if d_flap > -0.5:
            m_flap = clamp(d_flap + 0.5)
            # Golden amber gradient: #FDE047 -> #F59E0B
            flap_t = (px - 36.0 + (py - 12.0)) / 24.0
            flap_col = lerp([253, 224, 71], [245, 158, 11], flap_t)
            
            # Highlight on the diagonal crease
            if abs(px - py - 24.0) < 1.2:
                crease_h = (1.2 - abs(px - py - 24.0)) / 1.2 * 0.45
                flap_col = lerp(flap_col, [255, 255, 255], crease_h)
                
            pixel_rgb = lerp(pixel_rgb, flap_col, m_flap)

    # 4. Radiant Golden Idea Spark (4-point star at bottom right)
    # Center at (48.0, 44.0), radius R = 6.0
    sp_cx, sp_cy, sp_r = 48.0, 44.0, 6.0
    dx = abs(px - sp_cx)
    dy = abs(py - sp_cy)
    if dx < sp_r and dy < sp_r:
        val = math.sqrt(dx / sp_r) + math.sqrt(dy / sp_r)
        d_star = (val - 1.0) * (sp_r * 0.5)
        if d_star < 0.5:
            m_star = clamp(0.5 - d_star)
            star_t = (dx + dy) / (sp_r * 1.5)
            star_col = lerp([253, 224, 71], [245, 158, 11], star_t)
            core_d = math.hypot(dx, dy)
            if core_d < 1.3:
                core_m = clamp(1.3 - core_d)
                star_col = lerp(star_col, [255, 255, 255], core_m)
            pixel_rgb = lerp(pixel_rgb, star_col, m_star)

    # Mini spark at (54.0, 38.0), radius 2.6
    m_cx, m_cy, m_r = 54.0, 38.0, 2.6
    mdx = abs(px - m_cx)
    mdy = abs(py - m_cy)
    if mdx < m_r and mdy < m_r:
        mval = math.sqrt(mdx / m_r) + math.sqrt(mdy / m_r)
        d_mstar = (mval - 1.0) * (m_r * 0.5)
        if d_mstar < 0.5:
            m_mstar = clamp(0.5 - d_mstar) * 0.9
            pixel_rgb = lerp(pixel_rgb, [253, 224, 71], m_mstar)

    return [int(round(pixel_rgb[0])), int(round(pixel_rgb[1])), int(round(pixel_rgb[2])), int(round(pixel_a * 255.0))]

def render_icon(size, supersample=2):
    w, h = size, size
    buf = bytearray(w * h * 4)
    ss = supersample
    sub_step = 1.0 / ss
    weight = 1.0 / (ss * ss)

    for y in range(h):
        for x in range(w):
            r_acc, g_acc, b_acc, a_acc = 0.0, 0.0, 0.0, 0.0
            for sy in range(ss):
                for sx in range(ss):
                    u = (x + (sx + 0.5) * sub_step) / float(w)
                    v = (y + (sy + 0.5) * sub_step) / float(h)
                    c = sample_point(u, v)
                    r_acc += c[0] * weight
                    g_acc += c[1] * weight
                    b_acc += c[2] * weight
                    a_acc += c[3] * weight
            idx = (y * w + x) * 4
            buf[idx] = int(round(r_acc))
            buf[idx + 1] = int(round(g_acc))
            buf[idx + 2] = int(round(b_acc))
            buf[idx + 3] = int(round(a_acc))
    return bytes(buf)

print("Re-rendering icons with fixed fold geometry...")
sizes = [16, 32, 48, 180, 512]
png_data = {}

for sz in sizes:
    ss = 3 if sz <= 32 else 2
    raw = render_icon(sz, supersample=ss)
    png_bytes = make_png(sz, sz, raw)
    png_data[sz] = png_bytes
    
    if sz == 16:
        with open("c:/Users/hp/Desktop/Notes-app/favicon-16x16.png", "wb") as f:
            f.write(png_bytes)
        print("Updated favicon-16x16.png")
    elif sz == 32:
        with open("c:/Users/hp/Desktop/Notes-app/favicon-32x32.png", "wb") as f:
            f.write(png_bytes)
        print("Updated favicon-32x32.png")
    elif sz == 48:
        with open("c:/Users/hp/Desktop/Notes-app/favicon-48x48.png", "wb") as f:
            f.write(png_bytes)
        print("Updated favicon-48x48.png")
    elif sz == 180:
        with open("c:/Users/hp/Desktop/Notes-app/apple-touch-icon.png", "wb") as f:
            f.write(png_bytes)
        print("Updated apple-touch-icon.png")
    elif sz == 512:
        with open("c:/Users/hp/Desktop/Notes-app/favicon.png", "wb") as f:
            f.write(png_bytes)
        print("Updated favicon.png")

ico_dict = {16: png_data[16], 32: png_data[32], 48: png_data[48]}
ico_bytes = make_ico(ico_dict)
with open("c:/Users/hp/Desktop/Notes-app/favicon.ico", "wb") as f:
    f.write(ico_bytes)
print("Updated favicon.ico with 16x16, 32x32, and 48x48 mipmaps")
