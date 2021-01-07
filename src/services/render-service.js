/**
 * The MIT License (MIT)
 *
 * Igor Zinken 2020-2021 - https://www.igorski.nl
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { canvas, loader } from "zcanvas";
import { PNG } from "@/definitions/image-types";
import { LAYER_TEXT } from "@/definitions/layer-types";
import { getSpriteForLayer } from "@/factories/sprite-factory";
import { createCanvas, resizeToBase64 } from "@/utils/canvas-util";
import { getRotatedSize, getRotationCenter, getRectangleForSelection } from "@/utils/image-math";
import { loadGoogleFont } from "@/services/font-service";

const queue = [];
const MAX_8BIT = 255;
const HALF     = .5;

export const renderEffectsForLayer = async layer => {
    const { effects } = layer;
    const sprite = getSpriteForLayer( layer );

    if ( !sprite || !layer.source ) {
        return;
    }

    // if source is rotated, calculate the width and height for the current rotation
    const { width, height } = getRotatedSize( layer, effects.rotation );
    let cvs;
    if ( sprite._bitmap instanceof HTMLCanvasElement ) {
        cvs        = sprite._bitmap;
        cvs.width  = width;
        cvs.height = height;
    } else {
        ({ cvs } = createCanvas( width, height ));
    }
    const ctx = cvs.getContext( "2d" );

    if ( layer.type === LAYER_TEXT ) {
        await renderText( layer );
    }

    if ( hasEffects( layer )) {
        await renderTransformedSource( layer, ctx, layer.source, width, height, effects );
    } else {
        ctx.drawImage( layer.source, 0, 0 );
    }
    if ( hasFilters( layer )) {
        await renderFilters( cvs, layer );
    }

    // update on-screen canvas contents
    // note that updating the bitmap will also adjust the sprite bounds
    // as appropriate (e.g. on rotation), the Layer model remains unaffected by this
    sprite.setBitmap( cvs, width, height );
    sprite.invalidate();
};

/**
 * Creates a snapshot of the current document at its full size, returns a Blob.
 */
export const createDocumentSnapshot = async ( activeDocument, type, quality ) => {
    const { zcvs, cvs, ctx } = createFullSizeCanvas( activeDocument );
    const { width, height }  = activeDocument;

    // draw existing layers onto temporary canvas at full document scale
    const { layers } = activeDocument;
    for ( let i = 0, l = layers.length; i < l; ++i ) {
        const layer = layers[ i ];
        const sprite = getSpriteForLayer( layer );
        await renderEffectsForLayer( layer );
        sprite.draw( ctx, zcvs._viewport );
    }
    quality = parseFloat(( quality / 100 ).toFixed( 2 ));
    let base64 = cvs.toDataURL( type, quality );
    zcvs.dispose();

    // zCanvas magnifies content by the pixel ratio for a crisper result, downscale
    // to actual dimensions of the document
    const resizedImage = await resizeToBase64(
        base64,
        width  * ( window.devicePixelRatio || 1 ),
        height * ( window.devicePixelRatio || 1 ),
        width, height,
        type, quality
    );
    // fetch final base64 data so we can convert it easily to binary
    base64 = await fetch( resizedImage );
    return await base64.blob();
};

/**
 * Copy the selection defined in activeLayer into a separate Image
 */
export const copySelection = async ( activeDocument, activeLayer ) => {
    const { zcvs, cvs, ctx } = createFullSizeCanvas( activeDocument );
    const sprite = getSpriteForLayer( activeLayer );

    ctx.beginPath();
    activeLayer.selection.forEach(( point, index ) => {
        ctx[ index === 0 ? "moveTo" : "lineTo" ]( point.x, point.y );
    });
    ctx.closePath();
    ctx.save();
    ctx.clip();

    // draw active layer onto temporary canvas at full document scale
    sprite._isSelectMode = false; // prevents drawing selection outline into image
    sprite.draw( ctx, zcvs._viewport );
    ctx.restore();

    // when calculating the source rectangle we must take the device pixel ratio into account
    const pixelRatio = window.devicePixelRatio || 1;
    const selectionRectangle = getRectangleForSelection( activeLayer.selection );
    const selectionCanvas = createCanvas( selectionRectangle.width, selectionRectangle.height );
    selectionCanvas.ctx.drawImage(
        cvs,
        selectionRectangle.left  * pixelRatio, selectionRectangle.top    * pixelRatio,
        selectionRectangle.width * pixelRatio, selectionRectangle.height * pixelRatio,
        0, 0, selectionRectangle.width, selectionRectangle.height
    );
    zcvs.dispose();
    return await loader.loadImage( selectionCanvas.cvs.toDataURL( PNG ));
};

/* internal methods */

const hasEffects = layer => {
    if ( !!layer.mask ) {
        return true;
    }
    const { effects } = layer;
    return effects.rotation !== 0 || effects.mirrorX || effects.mirrorY;
};

const hasFilters = layer => {
    const { filters } = layer;
    return filters.levels || filters.contrast;
};

const renderText = async layer => {
    const { text } = layer;

    if ( !text.value ) {
        return;
    }
    let font = text.font;
    try {
        await loadGoogleFont( font ); // lazily loads font file upon first request
    } catch {
        font = "Arial"; // fall back to universally available Arial
    }

    const sourceCtx = layer.source.getContext( "2d" );
    sourceCtx.clearRect( 0, 0, layer.source.width, layer.source.height );
    sourceCtx.font      = `${text.size}px ${font}`;
    sourceCtx.fillStyle = text.color;

    const lines    = text.value.split( "\n" );
    let lineHeight = text.lineHeight;

    // if no custom line height was given, calculate optimal height for font
    if ( !lineHeight ) {
        const textMetrics = sourceCtx.measureText( "Wq" );
        lineHeight = text.size + Math.abs( textMetrics[ "actualBoundingBoxDescent" ]);
    }

    let y = 0;
    lines.forEach(( line, lineIndex ) => {
        y = lineHeight + ( lineIndex * lineHeight );

        if ( !text.spacing ) {
            // write entire line (0 spacing defaults to font spacing)
            sourceCtx.fillText( line, 0, y );
        } else {
            // write letter by letter (yeah... this is why we cache things)
            line.split( "" ).forEach(( letter, letterIndex ) => {
                sourceCtx.fillText( letter, letterIndex * text.spacing, y );
            });
        }
    });
};

const renderTransformedSource = async ( layer, ctx, sourceBitmap, width, height, { mirrorX, mirrorY, rotation }) => {
    const rotate = ( rotation % 360 ) !== 0;
    let targetX = mirrorX ? -width  : 0;
    let targetY = mirrorY ? -height : 0;

    const xScale = mirrorX ? -1 : 1;
    const yScale = mirrorY ? -1 : 1;

    ctx.save();
    ctx.scale( xScale, yScale );

    if ( rotate ) {
        const { x, y } = getRotationCenter({
            left   : 0,
            top    : 0,
            width  : mirrorX ? -width : width,
            height : mirrorY ? -height : height
        });
        ctx.translate( x, y );
        ctx.rotate( rotation );
        ctx.translate( -x, -y );
        targetX = x - layer.width  * HALF;
        targetY = y - layer.height * HALF;
    }
    ctx.drawImage( sourceBitmap, targetX, targetY );
    await renderMask( layer, ctx, targetX, targetY );

    ctx.restore();
};

const renderMask = async( layer, ctx, tX = 0, tY = 0 ) => {
    if ( !layer.mask ) {
        return;
    }
    ctx.save();
    ctx.translate( tX, tY );
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage( layer.mask, layer.maskX, layer.maskY );
    ctx.restore();
};

const renderFilters = async ( source, layer ) => {
    const { filters } = layer;
    const contrast    = Math.pow((( filters.contrast * 100 ) + 100 ) / 100, 2 ); // -100 to 100 range
    const levels      = filters.levels * 2; // 0 to 2 range

    const { width, height } = source;
    const ctx = source.getContext( "2d" );
    const pixels   = ctx.getImageData( 0, 0, width, height );
    const { data } = pixels;

    for ( let x = 0; x < width; ++x ) {
        for ( let y = 0; y < height; ++y ) {
            const i = ( y * width + x ) * 4;

            // 1. adjust level (note we leave the alpha channel unchanged)
            if ( levels ) {
                data[ i ]     = data[ i ]     * levels * levels; // R
                data[ i + 1 ] = data[ i + 1 ] * levels * levels; // G
                data[ i + 2 ] = data[ i + 2 ] * levels * levels; // B
            }
            // 2. adjust contrast (note we leave the alpha channel unchanged)
            if ( contrast ) {
                data[ i ]     = (( data[ i ]     / MAX_8BIT - HALF ) * contrast + HALF ) * MAX_8BIT; // R
                data[ i + 1 ] = (( data[ i + 1 ] / MAX_8BIT - HALF ) * contrast + HALF ) * MAX_8BIT; // G
                data[ i + 2 ] = (( data[ i + 2 ] / MAX_8BIT - HALF ) * contrast + HALF ) * MAX_8BIT; // B
            }
        }
    }
    ctx.clearRect( 0, 0, width, height );
    ctx.putImageData( pixels, 0, 0 );
};

/**
 * Create a (temporary) instance of zCanvas at the full document size.
 * This is used when creating snapshots
 */
const createFullSizeCanvas = document => {
    const { width, height } = document;
    const zcvs = new canvas({ width, height, viewport: { width: width * 10, height: height * 10 } });
    const cvs  = zcvs.getElement();
    const ctx  = cvs.getContext( "2d" );

    return { zcvs, cvs, ctx };
};
