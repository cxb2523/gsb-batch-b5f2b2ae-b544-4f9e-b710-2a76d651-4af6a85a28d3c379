"""State consistency across filament changes, retract/wipe and stack lifting.

Uses a synthetic two-filament job (no sample 3MF needed): the change template
ends at a known position (7.5, 93.25) with a known final retract, so the
writer's state after a change can be checked exactly.
"""
import re

import numpy as np
import pytest

from impasto import bambu, generate, parse, surface

# ends at X7.5 Y93.25, Z = max_layer_z + 1.5, filament retracted by @TC_RETRACT@
# - nothing of it is hardcoded in the generator, and the retract deliberately
# differs from the config's retract_length_toolchange (0.9): the generator must
# trust what the template does, not the config value
CHANGE_TEMPLATE = """\
; FilamentChange
M83
G1 X-13.5 Y90 F9000 ; to the chute
G1 E{flush_length} F300 ; purge
G1 E-@TC_RETRACT@ F1800 ; final retract
G1 X7.5 Y93.25 F3000 ; wipe end position
G1 Z{max_layer_z + 1.5} F1200 ; lift
"""

CONFIG = {
    "filament_colour": "#FFFFFF;#000000",
    "filament_diameter": "1.75;1.75",
    "retraction_length": "0.8;0.8",
    "retract_length_toolchange": "0.9;0.9",
    "retract_before_wipe": "70;70",
    "wipe": "1;1",
    "wipe_distance": "2;2",
    "nozzle_temperature": "210;210",
    "nozzle_temperature_range_high": "240;240",
    "fan_max_speed": "100;100",
    "filament_max_volumetric_speed": "10;10",
    "filament_flow_ratio": "1;1",
    "filament_flush_volumetric_speed": "5;5",
    "filament_flush_temp": "0;0",
    "flush_volumes_matrix": "0;140;140;0",
    "flush_multiplier": "1",
    "grab_length": "0",
    "outer_wall_line_width": "0.42",
    "line_width": "0.42",
    "layer_height": "0.2",
    "outer_wall_speed": "100",
    "default_acceleration": "6000",
}

TEMPLATE_END_XY = (7.5, 93.25)
TEMPLATE_RETRACT = 1.7                 # what the template really pulls back
SURFACE_Z = 5.0
OFF = 0.15                      # default z_offset


def make_job(tc_retract=TEMPLATE_RETRACT, **cfg):
    config = dict(CONFIG)
    config.update(cfg)
    tpl = CHANGE_TEMPLATE.replace("@TC_RETRACT@", str(tc_retract))
    config["change_filament_gcode"] = tpl.replace("\n", "\\n")
    lines = (["; HEADER_BLOCK_START", "; HEADER_BLOCK_END", "; CONFIG_BLOCK_START"]
             + [f"; {k} = {v}" for k, v in config.items()]
             + ["; CONFIG_BLOCK_END", "; EXECUTABLE_BLOCK_START", "G1 X20 Y50 Z5 E1",
                "; EXECUTABLE_BLOCK_END", "; MACHINE_END_GCODE_START", "M104 S0"])
    return bambu.load_bytes("\n".join(lines).encode(), "x.gcode")


def make_tp():
    seg = np.array([[20, y, 140, y, SURFACE_Z] for y in np.arange(50, 80, 0.5)], dtype=np.float32)
    n = len(seg)
    return parse.Toolpaths(seg=seg, width=np.full(n, 0.42, dtype=np.float32),
                           feat=np.zeros(n, dtype=np.uint8), fil=np.zeros(n, dtype=np.int8),
                           layer=np.zeros(n, dtype=np.int16), features=["Top surface"],
                           layer_z=[SURFACE_Z], last_filament=0, max_z=SURFACE_Z,
                           end_pos=(140.0, 50.0, SURFACE_Z))


@pytest.fixture(scope="module")
def setup():
    job = make_job()
    tp = make_tp()
    g = surface.analyze(surface.heightmap(tp))
    return job, tp, g


def e_moves(text, start=0, end=None):
    """(index, E) of every G1 with an E word in lines[start:end]."""
    lines = text.split("\n")
    out = []
    for i, ln in enumerate(lines[start:end], start):
        if ln.startswith("G1"):
            m = re.search(r"\bE(-?[\d.]+)", ln.split(";")[0])
            if m:
                out.append((i, float(m.group(1)), "X" in ln or "Y" in ln))
    return out


def test_first_move_after_change_starts_at_template_end(setup):
    job, tp, g = setup
    paths = [{"slot": 0, "pts": [[60, 56], [90, 56]]},
             {"slot": 1, "pts": [[60, 58], [90, 58]]}]        # second colour right after the first
    res = generate.generate(job, tp, g, paths, generate.Params(wipe=0))
    assert res.stats["toolchanges"] == 1
    ch = np.nonzero(res.moves[:, 0] == 2)[0]
    assert len(ch) == 1
    # the first line was printed at SURFACE_Z + OFF before the change
    end_z = SURFACE_Z + OFF + 1.5
    rec = res.moves[ch[0]]
    assert np.allclose(rec[5:8], [*TEMPLATE_END_XY, end_z], atol=1e-3)     # change record ends there
    first = res.moves[ch[0] + 1]
    assert np.allclose(first[2:5], [*TEMPLATE_END_XY, end_z], atol=1e-3)   # next move starts there


def test_reprime_after_change_is_template_retract_plus_prime(setup):
    job, tp, g = setup
    paths = [{"slot": 0, "pts": [[60, 56], [90, 56]]},
             {"slot": 1, "pts": [[60, 58], [90, 58]]}]
    for prime, want in ((0.2, 1.9), (0.5, 2.2)):            # 1.7 from the template + prime
        res = generate.generate(job, tp, g, paths, generate.Params(wipe=0, prime=prime))
        lines = res.gcode.split("\n")
        start = next(i for i, l in enumerate(lines) if l.startswith("; FilamentChangeGCodeStart"))
        end = next(i for i, l in enumerate(lines) if l.startswith("; FilamentChangeGCodeEnd"))
        primes = [(i, e) for i, e, xy in e_moves(res.gcode, end) if e > 0 and not xy]
        assert primes and abs(primes[0][1] - want) < 1e-6
        # total retraction outside the template: one before the change, one at the end
        neg = [e for i, e, xy in e_moves(res.gcode) if e < 0 and not start <= i <= end]
        assert abs(sum(neg) + 2 * 0.8) < 1e-6


def test_wipe_runs_back_along_the_line_just_printed(setup):
    job, tp, g = setup
    paths = [{"slot": 0, "pts": [[60, 56], [90, 56]]},
             {"slot": 0, "pts": [[60, 59], [90, 59]]}]
    res = generate.generate(job, tp, g, paths,
                            generate.Params(wipe=2.0, retract=0.8, retract_before_wipe=0))
    wipes = res.moves[res.moves[:, 0] == 3]
    assert len(wipes) > 0
    assert (res.flags[res.moves[:, 0] == 3] & generate.FLAG_WIPE).all()
    # 2 mm back along each of the two lines
    d = np.hypot(wipes[:, 5] - wipes[:, 2], wipes[:, 6] - wipes[:, 3]).sum()
    assert abs(d - 2.0 * res.stats["retracts"]) < 1e-6
    assert res.stats["retracts"] == 2
    # split into one block per retract (blocks do not connect to each other)
    blocks, cur = [], [wipes[0]]
    for mv in wipes[1:]:
        if np.hypot(mv[2] - cur[-1][5], mv[3] - cur[-1][6]) > 1e-6:
            blocks.append(np.array(cur))
            cur = []
        cur.append(mv)
    blocks.append(np.array(cur))
    assert len(blocks) == 2
    ex = res.moves[res.moves[:, 0] == 0]
    for blk, y in zip(blocks, (56, 59)):
        line_end = ex[ex[:, 6] == y][-1]                     # last extrusion of that stroke
        assert np.allclose(blk[0, 2:4], line_end[5:7], atol=1e-3)   # starts where the line ended
        assert (np.abs(blk[:, 6] - y) < 1e-3).all()          # stays on the line just printed
        assert abs(np.hypot(blk[:, 5] - blk[:, 2], blk[:, 6] - blk[:, 3]).sum() - 2.0) < 1e-6
        dx = np.diff(blk[:, 5])
        assert (dx > 0).all() or (dx < 0).all()              # strictly backwards, never forwards
        assert abs(abs(blk[-1, 5] - blk[0, 2]) - 2.0) < 1e-3
    # every retract pulls exactly the retract length back
    neg = [e for _, e, _ in e_moves(res.gcode) if e < 0]
    assert abs(sum(neg) + 0.8 * res.stats["retracts"]) < 1e-6
    # wipe=0: unchanged behaviour, no wipe moves at all
    off = generate.generate(job, tp, g, paths, generate.Params(wipe=0, retract=0.8))
    assert (off.moves[:, 0] == 3).sum() == 0


def test_no_wipe_along_the_old_line_right_after_a_change(setup):
    job = make_job(tc_retract=0)                             # the template retracts nothing
    tp = make_tp()
    g = surface.analyze(surface.heightmap(tp))
    paths = [{"slot": 0, "pts": [[60, 56], [90, 56]]},
             {"slot": 1, "pts": [[60, 58], [90, 58]]}]
    res = generate.generate(job, tp, g, paths,
                            generate.Params(wipe=2.0, retract=0.8, retract_before_wipe=0, prime=0.0))
    ch = np.nonzero(res.moves[:, 0] == 2)[0]
    assert len(ch) == 1
    # the wipe before the change follows the old line (sanity: wipes do work here)
    assert (res.flags[:ch[0]] & generate.FLAG_WIPE).any()
    # between the change and the first extrusion of the new colour: no wipe at all
    after = np.arange(ch[0] + 1, len(res.moves))
    first_extr = next(i for i in after if res.moves[i, 0] == 0)
    span = res.moves[ch[0] + 1:first_extr]
    assert (span[:, 0] != 3).all()
    assert (res.flags[ch[0] + 1:first_extr] & generate.FLAG_WIPE).sum() == 0
    # the retract there is a plain E-only retract
    lines = res.gcode.split("\n")
    end = next(i for i, l in enumerate(lines) if l.startswith("; FilamentChangeGCodeEnd"))
    plain = [(i, e) for i, e, xy in e_moves(res.gcode, end) if e < 0 and not xy]
    assert plain and abs(plain[0][1] + 0.8) < 1e-6


def _crossing_design():
    # B (element 0) and C (element 1) in slot 1; C touches B at its end, so B
    # prints first. The travel from the change template's end to B crosses C
    # at about (51.6, 62.4) while C is still unprinted.
    return [{"slot": 1, "order": 0, "pts": [[55, 60], [75, 60]]},
            {"slot": 1, "order": 1, "pts": [[30, 75], [55.5, 60.1]]}]


def test_travel_moves_are_not_stamped_into_the_heightmap(setup):
    job, tp, g = setup
    res = generate.generate(job, tp, g, _crossing_design(), generate.Params(dir_opt=False))
    ex = res.moves[res.moves[:, 0] == 0]
    c = ex[ex[:, 6] > 60.05]                                  # C's extrusion moves (B sits at y=60)
    assert len(c) > 10
    # where the travel from the chute crossed C, C stays on the plain surface
    near = c[np.hypot(c[:, 5] - 51.6, c[:, 6] - 62.4) < 0.5]
    assert len(near) > 0
    assert (near[:, 7] < SURFACE_Z + OFF + 0.1).all()
    # sanity: stacking itself works - C is lifted where it lies on B
    on_b = c[np.hypot(c[:, 5] - 55.5, c[:, 6] - 60.1) < 0.5]
    assert len(on_b) > 0 and (on_b[:, 7] > SURFACE_Z + OFF + 0.1).any()


def test_stack_off_ignores_printed_lines(setup):
    job, tp, g = setup
    res = generate.generate(job, tp, g, _crossing_design(), generate.Params(dir_opt=False, stack=False))
    ex = res.moves[res.moves[:, 0] == 0]
    c = ex[ex[:, 6] > 60.05]
    assert len(c) > 10
    assert c[:, 7].max() - c[:, 7].min() < 0.02               # flat: HNP never lifts
