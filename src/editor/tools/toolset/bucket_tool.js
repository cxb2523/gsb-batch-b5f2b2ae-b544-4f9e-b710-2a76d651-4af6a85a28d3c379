import Color from "color";
import { BaseTool } from "../base_tool.js";
import { getFaceFromCoords } from "../../layers/texture_utils.js";
import { clamp } from "../../../helpers.js";
import { IMAGE_HEIGHT, IMAGE_WIDTH } from "../../../constants.js";

const TRANSPARENT_COLOR = new Color("#000000").alpha(0);

class BucketTool extends BaseTool {
  constructor(config) {
    super(config, {
      id: "bucket",
      icon: "bucket",
      name: "Paint Bucket [G]",
      description: "Simple tool for filling large closed areas with a specific color.\nUse the left mouse button to fill, and the right mouse button to erase.",
      providesColor: true, // Whether or not drawing with this tool adds to recent colors.
      desktopLayout: true,
      mobileLayout: true,
    });
  }

  cursor = { x: 0, y: 0 };
  replaceColor = false;
  lastPart;
  lastFace;
  _unsetEraseOnUp = false;

  down(toolData) {
    this._checkErase(toolData);

    const texture = toolData.texture;
    const point = toolData.getCoords();
    const color = this.config.get("bucketErase", false) ? () => TRANSPARENT_COLOR : this.config.getColor.bind(this.config);
    const old_color = toolData.texture.getPixel({ x: point.x, y: point.y });
    const limbs = {
      "head_inner": [8, 8, 8, 0, 0],
      "head_outer": [8, 8, 8, 32, 0],
      "torso_inner": [8, 12, 4, 16, 16],
      "torso_outer": [8, 12, 4, 16, 32],
      "right_arm_inner_classic": [4, 12, 4, 40, 16],
      "right_arm_outer_classic": [4, 12, 4, 40, 32],
      "left_arm_inner_classic": [4, 12, 4, 32, 48],
      "left_arm_outer_classic": [4, 12, 4, 48, 48],
      "right_arm_inner_slim": [3, 12, 4, 40, 16],
      "right_arm_outer_slim": [3, 12, 4, 40, 32],
      "left_arm_inner_slim": [3, 12, 4, 32, 48],
      "left_arm_outer_slim": [3, 12, 4, 48, 48],
      "right_leg_inner": [4, 12, 4, 0, 16],
      "right_leg_outer": [4, 12, 4, 0, 32],
      "left_leg_inner": [4, 12, 4, 16, 48],
      "left_leg_outer": [4, 12, 4, 0, 48],
      "ears": [6, 6, 1, 24, 0],
    }

    this.replaceColor = this.config.get("fillStyle")==="replace-color";
    this.cubeUV = this.config.get("fillStyle")==="fill-cube-connected" || this.config.get("fillStyle")==="fill-cube-replace";
    this.replaceWithColor = this.config.get("fillStyle")==="fill-cube-replace"||this.config.get("fillStyle")==="fill-face-replace";

    this.cursor = point;
    if (this.isFaceMode()) {
      this.draw_face(toolData, texture, point, color);
    } else if (!this.replaceColor) {
      Object.keys(limbs).forEach(key => {
        if ((toolData.variant === 'slim' && key.endsWith("classic")) ||
            (toolData.variant === 'classic' && key.endsWith("slim"))) {
          return;
        }
        this.draw_box_uv(limbs[key], texture, point, color, old_color);
      });

    } else {
        this.draw_replace_color(texture, color, old_color);
    }

    return texture.toTexture();
  }

  fillStyle() {
    return this.config.get("fillStyle");
  }

  isFaceMode() {
    const style = this.fillStyle();
    return style === "fill-face-connected" || style === "fill-face-replace";
  }

  // Restrict the fill to the single face under the cursor, using the uv map to
  // resolve which part / layer / face the clicked pixel belongs to.
  draw_face(toolData, texture, point, color) {
    const seed = this._resolveFaceSeed(toolData.variant, point);
    if (!seed) { return; }

    const { rect } = seed;
    const x = rect.x;
    const y = rect.y;
    const maxX = x + Math.abs(rect.width) - 1;
    const maxY = y + Math.abs(rect.height) - 1;

    if (this.fillStyle() === "fill-face-replace") {
      for (let px = x; px <= maxX; px++) {
        for (let py = y; py <= maxY; py++) {
          texture.putPixel({ x: px, y: py }, color());
        }
      }
      return;
    }

    // Face connected: four-neighbour flood fill, matching same coloured pixels
    // and never leaving the face rectangle.
    const { x: startX, y: startY } = seed.point;
    const startColor = texture.getPixel({ x: startX, y: startY });
    const queue = [{ x: startX, y: startY }];
    const visited = new Set();
    const filled = [];

    while (queue.length > 0) {
      const { x: px, y: py } = queue.pop();

      if (px < x || px > maxX || py < y || py > maxY) continue;

      const key = `${px},${py}`;
      if (visited.has(key)) continue;
      visited.add(key);

      if (!this.colorsMatch(texture.getPixel({ x: px, y: py }), startColor)) continue;

      filled.push({ x: px, y: py });
      queue.push(
        { x: px + 1, y: py },
        { x: px - 1, y: py },
        { x: px, y: py + 1 },
        { x: px, y: py - 1 },
      );
    }

    filled.forEach(({ x: px, y: py }) => {
      texture.putPixel({ x: px, y: py }, color());
    });
  }

  // Resolve the face under the cursor. If rounding places the point just
  // outside the texture's face rectangles (e.g. exactly on a seam), snap to the
  // nearest pixel that does belong to a face.
  _resolveFaceSeed(variant, point) {
    const x = clamp(Math.floor(point.x), 0, IMAGE_WIDTH - 1);
    const y = clamp(Math.floor(point.y), 0, IMAGE_HEIGHT - 1);

    const candidates = [[x, y], [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];

    for (const [cx, cy] of candidates) {
      if (cx < 0 || cy < 0 || cx >= IMAGE_WIDTH || cy >= IMAGE_HEIGHT) continue;

      const face = getFaceFromCoords(variant, { x: cx, y: cy });
      if (!face) { continue; }

      const { rect } = face;
      return {
        face,
        rect,
        point: {
          x: clamp(cx, rect.x, rect.x + Math.abs(rect.width) - 1),
          y: clamp(cy, rect.y, rect.y + Math.abs(rect.height) - 1),
        },
      };
    }

    return undefined;
  }

  move(toolData) {
    this._checkErase(toolData);
    const texture = toolData.texture;
    return texture.toTexture();
  }

  up() {
    super.up();

    if (this._unsetEraseOnUp) {
      this.config.set("bucketErase", false);
      this._unsetEraseOnUp = false;
    }
  }

  draw_replace_color(texture, color, old_color){
    const width = 64;
    const height = 64;
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (this.colorsMatch(texture.getPixel({ x, y }), old_color) && (((x+8)%32>=16&&y>=0&&y<=7) || (y>=8&&y<=15) || (x>=4&&x<=11&&y>=16) || (x>=20&&x<=35&&y>=16&&y<=35) || (x>=44&&x<=51&&y>=16&&y<=35) || (x>=0&&x<=55&&y>=20&&y<=31) || (x>=0&&x<=55&&y>=36&&y<=47) || ((x+4)%16>=8&&y>=48) || y>=52 )) {
          texture.putPixel({ x, y }, color());
        }
      }
    }
  }

  draw_box_uv([box_width, box_height, box_depth, offset_x, offset_y], texture, point, color, old_color) {
    if (this.isInArea(point, offset_x+box_depth, offset_y, offset_x+box_depth+(2*box_width)-1, offset_y+box_depth+box_height-1)||this.isInArea(point, offset_x, offset_y+box_depth, offset_x+(2*(box_depth+box_width))-1, offset_y+box_depth+box_height-1)) {
      const queue = [point];
      const visited = new Set();
      const width = texture.canvas.width;
      const height = texture.canvas.height;
      let queue_length;
      let previous_queue_legth;

      for (let i = 0; i<((box_width*box_height*2)+(box_width*box_depth*2)+(box_height*box_depth*2)); i++) {
        queue_length = queue.length;
        for (let j = 0; j < queue_length; j++) {
          const { x, y } = queue[j];
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          if (visited.has(`${x},${y}`)) continue;
          visited.add(`${x},${y}`);

          if (this.cubeUV) {
            // The lines below limit the bucket tool from spilling over to other limbs and parts of the cube that aren't physically connected
            this.UV(x+1<=width&&!((x==(offset_x+box_depth+box_width-1)&&y>=offset_y&&y<=(offset_y+box_depth-1))||(x==(offset_x+box_depth+(box_width*2)-1)&&y>=offset_y&&y<=(offset_y+box_depth-1))||(x==(offset_x+(box_depth*2)+(box_width*2)-1)&&y>=(offset_y+box_depth)&&y<=(offset_y+box_depth+box_height-1))), { x: x + 1, y },texture,old_color,queue);
            this.UV(x-1>=0&&!((x==(offset_x+box_depth)&&y>=(offset_y)&&y<=(offset_y+box_depth-1))||(x==(offset_x+box_depth+box_width)&&y>=(offset_y)&&y<=(offset_y+box_depth-1))||(x==offset_x&&y>=(offset_y+box_depth)&&y<=(offset_y+box_depth+box_height-1))), { x: x - 1, y },texture,old_color,queue);
            this.UV(y+1<=height&&!((y==(offset_y+box_depth-1)&&x>=(offset_x+box_depth+box_width)&&x<=(offset_x+box_depth+(box_width*2)-1))||(y==(offset_y+box_depth+box_height-1)&&x>=offset_x&&x<=(offset_x+(box_width*2)+(box_depth*2)-1))), { x, y: y + 1 },texture,old_color,queue);
            this.UV(y-1>=0&&!((y==offset_y&&x>=(offset_x+box_depth)&&x<=(offset_x+box_depth+box_width*2))||(y==(offset_y+box_depth)&&x>=offset_x&&x<=(offset_x+box_depth-1))||(y==(offset_y+box_depth)&&x>=(offset_x+box_depth+box_width)&&x<=(offset_x+(box_depth*2)+(box_width*2)-1))), { x, y: y - 1 },texture,old_color,queue);

            // Left-Right UV
            this.UV(x==offset_x&&y>=(offset_y+box_depth)&&y<=(offset_y+box_depth+box_height-1), { x: (offset_x+(box_depth*2)+(box_width*2)-1), y },texture,old_color,queue);
            this.UV(x==(offset_x+(box_depth*2)+(box_width*2)-1)&&y>=(offset_y+box_depth)&&y<=(offset_y+box_depth+box_height-1), { x: offset_x, y },texture,old_color,queue);
            // 1st Top UV
            this.UV(x>=offset_x&&x<=(offset_x+box_depth)&&y==(offset_y+box_depth), { x: (offset_x+box_depth), y: (offset_y+(x-offset_x)) },texture,old_color,queue);
            this.UV(y>=offset_y&&y<=(offset_y+box_depth-1)&&x==(offset_x+box_depth), { x: (offset_x+(y-offset_y)), y: (offset_y+box_depth) },texture,old_color,queue);
            // 2nd Top UV
            this.UV(x>=(offset_x+box_depth+box_width)&&x<=(offset_x+(box_depth*2)+box_width-1)&&y==(offset_y+box_depth), { x: (offset_x+box_depth+box_width-1), y: (offset_y+((offset_x+(box_depth*2)+box_width-1)-x)) },texture,old_color,queue);
            this.UV(y>=offset_y&&y<=(offset_y+box_depth)&&x==(offset_x+box_depth+box_width-1), { x: (offset_x+((offset_y+(box_depth*2)+box_width-1)-y)), y: (offset_y+box_depth) },texture,old_color,queue);
            // 3rd Top UV
            this.UV(y==(offset_y+box_depth)&&x>=(offset_x+(box_depth*2)+box_width)&&x<=(offset_x+(box_depth*2)+(box_width*2)), { x: (offset_x*2+box_depth*3+box_width*2-x-1), y: offset_y },texture,old_color,queue);
            this.UV(y==offset_y&&x>=(offset_x+box_depth)&&x<=(offset_x+box_depth+box_width-1), { x: ((offset_x*2)+(box_depth*3)+(box_width*2)-x-1), y: (offset_y+box_depth) },texture,old_color,queue);
            // 1st Bottom UV
            this.UV(y==(offset_y+box_depth+box_height-1)&&x>=offset_x&&x<=(offset_x+box_depth-1), { x: (offset_x+box_depth+box_width), y: (offset_y+(x-offset_x)) },texture,old_color,queue);
            this.UV(x==(offset_x+box_depth+box_width)&&y>=offset_y&&y<=(offset_y+box_depth-1), { x: (offset_x+(y-offset_y)), y: (offset_y+box_depth+box_height-1) },texture,old_color,queue);
            // 2nd Bottom UV
            this.UV(y==(offset_y+box_depth+box_height-1)&&x>=(offset_x+box_depth)&&x<=(offset_x+box_depth+box_width-1), { x: (x+(box_width)), y: (offset_y+box_depth-1) },texture,old_color,queue);
            this.UV(y==(offset_y+box_depth-1)&&x>=(offset_x+box_depth+box_width)&&x<=(offset_x+box_depth+(box_width*2)-1), { x: (x-(box_width)), y: (offset_y+box_depth+box_height-1) },texture,old_color,queue);
            // 3rd Bottom UV
            this.UV(y==(offset_y+box_depth+box_height-1)&&x>=(offset_x+box_depth+box_width)&&x<=(offset_x+(box_depth*2)+box_width-1), { x: (offset_x+box_depth+box_width*2-1), y: (offset_y+(offset_x+box_depth*2+box_width-x-1)) },texture,old_color,queue);
            this.UV(x==(offset_x+box_depth+box_width*2-1)&&y>=offset_y&&y<=(offset_y+box_depth-1), { x: (offset_x+box_depth*2+box_width+(offset_y-y-1)), y: (offset_y+box_depth+box_height-1) },texture,old_color,queue);
            // 4th Bottom UV
            this.UV(y==(offset_y+box_depth+box_height-1)&&x>=(offset_x+box_depth*2+box_width)&&x<=(offset_x+(box_depth*2)+(box_width*2)-1), { x: (offset_x*2 + box_depth*3 + box_width*3 - x - 1), y: offset_y },texture,old_color,queue);
            this.UV(y==offset_y&&x>=(offset_x+box_depth+box_width)&&x<=(offset_x+box_depth+box_width*2-1), { x: (offset_x*2 + box_depth*3 + box_width*3 - x - 1), y: (offset_y+box_depth+box_height-1) },texture,old_color,queue);
          } else {
            this.UV(x+1<=width&&!((x==(offset_x+box_depth-1)&&y>=(offset_y+box_depth))||(x==(offset_x+box_depth+box_width-1))||(x==(offset_x+box_depth+box_width*2-1)&&y<(offset_y+box_depth))||(x==(offset_x+box_depth*2+box_width-1)&&y>=(offset_y+box_depth))||(x==(offset_x+box_depth*2+box_width*2-1))), { x: x + 1, y },texture,old_color,queue);
            this.UV(x-1>=0&&!((x==(offset_x))||(x==(offset_x+box_depth))||(x==(offset_x+box_depth+box_width)||(x==(offset_x+box_depth*2+box_width))&&(y>=(offset_y+box_depth)))), { x: x - 1, y },texture,old_color,queue);
            this.UV(y+1<=height&&!(y==(offset_y+box_depth-1)||(y==(offset_y+box_depth+box_height-1))), { x, y: y + 1 },texture,old_color,queue);
            this.UV(y-1>=0&&!((y==(offset_y)||y==(offset_y+box_depth))), { x, y: y - 1 },texture,old_color,queue);
          }
        }
        if (previous_queue_legth === queue.length){
          break;
        }
        previous_queue_legth = queue.length;
      }
      for (let i = 0; i < queue.length; i++) {
        texture.putPixel({ x:queue[i].x, y:queue[i].y }, color());
      }
    }
  }


  
  colorsMatch(c1, c2) {
    const tolerance = 0.01*255;
    const alpha_tolerance = 0.05;
    return (
      c1 && c2 &&
      c1.red()-tolerance <= c2.red() && c1.red()+tolerance >= c2.red() &&
      c1.green()-tolerance <= c2.green() && c1.green()+tolerance >= c2.green() &&
      c1.blue()-tolerance <= c2.blue() && c1.blue()+tolerance >= c2.blue() &&
      c1.alpha()-alpha_tolerance <= c2.alpha() && c1.alpha()+alpha_tolerance >= c2.alpha() 
    );
  }

  isInArea(point,x,y,end_x,end_y){
    return (point.x>=x&&point.x<=end_x&&point.y>=y&&point.y<=end_y);
  }

  UV(area,move_to,texture,old_color,queue){
    if (area&&(this.colorsMatch(texture.getPixel(move_to), old_color)||this.replaceWithColor)&&!queue.includes(move_to)) {
      queue.push(move_to);
    }
  }

  _checkErase(toolData) {
    if (this._unsetEraseOnUp || this.config.get("bucketErase", false)) return;
    if (toolData.button !== 2) return;

    this.config.set("bucketErase", true);
    this._unsetEraseOnUp = true;
  }
}

export default BucketTool;
