'use strict';

function canvas_context_create(){
    const element = canvas_element_get();

    if(canvas_element_listened !== element){
        element.addEventListener('contextlost', canvas_context_lost);
        element.addEventListener('contextrestored', canvas_context_restored);
        canvas_element_listened = element;
    }

    if(globalThis.onresize !== canvas_resize){
        globalThis.onresize = canvas_resize;
    }
    if(!canvas_args.contextmenu
      && element.oncontextmenu !== canvas_contextmenu){
        element.oncontextmenu = canvas_contextmenu;
    }

    const context = element.getContext(
      '2d',
      {
        'alpha': false,
      }
    );
    if(context === null){
        return 0;
    }
    context.canvas.style.cursor = canvas_args.cursor;

    return context;
}

function canvas_context_lost(event){
    event.preventDefault();

    if(canvas_lost){
        return;
    }

    canvas_state.logic = canvas_interval_active('repo_logic');
    canvas_state.menu = core_menu_open;
    canvas_state.running = canvas_interval_active('canvas_drawloop');
    canvas_lost = true;

    core_interval_suspend();
    canvas = 0;
}

function canvas_context_restored(){
    const state = {
      'logic': canvas_state.logic,
      'menu': canvas_state.menu,
      'running': canvas_state.running,
    };

    canvas_lost = false;
    canvas_state = {
      'logic': false,
      'menu': false,
      'running': false,
    };

    if(canvas === 0){
        canvas = canvas_context_create();
    }
    if(canvas === 0){
        core_interval_unsuspend();
        canvas_interval_pause('canvas_drawloop');
        canvas_interval_pause('repo_logic');
        return;
    }

    canvas_resize();
    core_interval_unsuspend();

    if(core_menu_open){
        return;
    }

    if(state.running
      || state.menu){
        canvas_interval_resume('canvas_drawloop');
    }
    if(state.logic
      || state.menu){
        canvas_interval_resume('repo_logic');
    }
}

function canvas_draw(){
    if(canvas === 0){
        return;
    }

    if(canvas_properties.clearColor === '#000'){
        canvas.clearRect(
          0,
          0,
          canvas_properties.width,
          canvas_properties.height
        );

    }else{
        canvas_setproperties({
          'fillStyle': canvas_properties.clearColor,
        });
        canvas.fillRect(
          0,
          0,
          canvas_properties.width,
          canvas_properties.height
        );
    }

    globalThis.repo_drawlogic?.();
}

function canvas_drawloop(){
    canvas_draw();

    const interval = core_intervals.canvas_drawloop;
    if(canvas !== 0
      && interval !== void 0
      && !interval.paused){
        core_interval_animationFrame('canvas_drawloop');
    }
}

function canvas_draw_path({
  properties = {},
  style = canvas_properties.style,
  translate = false,
  vertices,
  x = 0,
  y = 0,
} = {}){
    if(translate){
        canvas.save();
        canvas.translate(x, y);
    }

    canvas.beginPath();
    for(const vertex of vertices){
        const data = [...vertex];
        canvas[data.shift()](...data);
    }
    canvas.closePath();

    canvas_setproperties(properties);
    canvas[style]();

    if(translate){
        canvas.restore();
    }
}

function canvas_element_get(){
    if(canvas_element === 0){
        canvas_element = core_html({
          'parent': document.body,
          'properties': {
            'id': 'canvas',
          },
          'type': 'canvas',
        });
    }
    if(!canvas_element.isConnected){
        document.body.append(canvas_element);
    }

    return canvas_element;
}

function canvas_gradient({
  args,
  stops,
  type = 'createLinearGradient',
} = {}){
    const gradient = canvas[type](...args);
    for(const step of stops){
        gradient.addColorStop(
          step.offset || 0,
          step.color || '#000'
        );
    }
    return gradient;
}

function canvas_init({
  contextmenu = true,
  cursor = 'default',
  interval = true,
} = {}){
    canvas_args = {
      'contextmenu': contextmenu,
      'cursor': cursor,
      'interval': interval,
    };
    canvas_lost = false;
    canvas_state = {
      'logic': false,
      'menu': false,
      'running': false,
    };

    canvas = canvas_context_create();

    canvas_setproperties({
      'clearColor': '#000',
      'fillStyle': '#fff',
      'font': '200% monospace',
      'height': 0,
      'lineJoin': 'miter',
      'lineWidth': 1,
      'strokeStyle': '#fff',
      'style': 'fill',
      'textAlign': 'start',
      'textBaseline': 'alphabetic',
      'width': 0,
    });

    canvas_resize();

    entity_set({
      'defaults': true,
      'properties': {
        'x': 0,
        'y': 0,
      },
      'type': 'canvas',
    });

    if(interval){
        core_interval_modify({
          'id': 'repo_logic',
          'interval': 1000 / 60,
          'paused': true,
          'todo': globalThis.repo_logic,
        });
        core_interval_modify({
          'id': 'canvas_drawloop',
          'interval': -1,
          'paused': true,
          'todo': canvas_drawloop,
        });
    }

    if(!core_menu_open){
        canvas_setmode();
    }
}

function canvas_interval_active(id){
    const interval = core_intervals[id];
    return interval !== void 0
      && !interval.paused;
}

function canvas_interval_pause(id){
    if(core_intervals[id] === void 0){
        return;
    }

    core_interval_pause(id);
}

function canvas_interval_resume(id){
    if(core_intervals[id] === void 0
      || core_intervals[id].lock){
        return;
    }

    core_interval_resume(id);
}

function canvas_resize(){
    if(canvas === 0){
        return;
    }

    const draw = canvas_properties.width_half;

    canvas_properties.height = globalThis.innerHeight;
    canvas_properties.height_half = canvas_properties.height / 2;
    canvas.canvas.height = canvas_properties.height;

    canvas_properties.width = globalThis.innerWidth;
    canvas_properties.width_half = canvas_properties.width / 2;
    canvas.canvas.width = canvas_properties.width;

    Object.assign(
      canvas,
      canvas_properties
    );

    globalThis.repo_resizelogic?.();
    if(draw){
        canvas_draw();
    }
}

function canvas_setmode(mode){
    entity_remove_all();

    core_mode = mode === void 0
      ? 0
      : mode;

    globalThis.repo_load?.(core_mode);

    if(core_menu_open){
        core_escape(false);

    }else{
        canvas_draw();
        core_interval_resume_all();
    }
}

function canvas_setproperties(properties){
    Object.assign(
      canvas_properties,
      properties
    );
    if(canvas !== 0){
        Object.assign(
          canvas,
          properties
        );
    }
}

function canvas_contextmenu(){
    return false;
}

globalThis.canvas = 0;
globalThis.canvas_args = {};
globalThis.canvas_element = 0;
globalThis.canvas_element_listened = 0;
globalThis.canvas_lost = false;
globalThis.canvas_properties = {};
globalThis.canvas_state = {
  'logic': false,
  'menu': false,
  'running': false,
};
