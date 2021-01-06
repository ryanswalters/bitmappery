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
import Vue from "vue";
import { canvas } from "zcanvas";

class ZoomableCanvas extends canvas {
    constructor( opts, store ) {
        super( opts );

        // Vuex root store reference
        this.store = store;

        this.documentScale = 1;
        this.setZoomFactor( 1 );
    }

    setDocumentScale( targetWidth, targetHeight, scale, zoom, activeDocument = null ) {
        const { left, top, width, height } = this._viewport;

        let scrollWidth  = this._width  - width;
        let scrollHeight = this._height - height;

        // cache the current scroll offset so we can zoom from the current offset
        // note that by default we zoom from the center (when document was unscrolled)
        const ratioX = ( left / scrollWidth ) || .5;
        const ratioY = ( top / scrollHeight ) || .5;

        this.setDimensions( targetWidth, targetHeight, true, true );
        this.setZoomFactor( scale * zoom, scale * zoom ); // eventually replace with zCanvas.setZoom()

        // update scroll widths after scaling operation

        scrollWidth  = this._width  - width;
        scrollHeight = this._height - height;

        // maintain relative scroll offset after rescale
        this.panViewport( scrollWidth  * ratioX, scrollHeight * ratioY, true );

        if ( activeDocument ) {
            this.documentScale = activeDocument.width / this._width; // the scale of the Document relative to this on-screen canvas
        }
    }

    setZoomFactor( scale ) {
        this.zoomFactor = scale;

        // This zoom factor logic should move into the zCanvas
        // library where updateCanvasSize() takes this additional factor into account

        this._canvasContext.scale( scale, scale );
        this.invalidate();
    }

    /* zCanvas.canvas overrides */

    // see QQQ comments to see what the difference is. Ideally these changes
    // should eventually be propagated to the zCanvas library.

    render() {
        const now   = Date.now();  // current timestamp
        const delta = now - this._lastRender;

        this._renderPending = false;
        this._lastRender    = now - ( delta % this._renderInterval );

        // in case a resize was requested execute it now as we will
        // immediately draw nwe contents onto the screen

        if ( this._enqueuedSize ) {
            updateCanvasSize( this );
        }

        const ctx = this._canvasContext;
        let theSprite;

        if ( ctx ) {

            // QQQ zoomFactor must be taken into account

            const { zoomFactor } = this;

            const width  = this._width  / zoomFactor;
            const height = this._height / zoomFactor;

            const viewport = { ...this._viewport };
            Object.entries( viewport ).forEach(([ key, value ]) => {
                viewport[ key ] = value / zoomFactor;
            });

            // E.O. QQQ

            // clear previous canvas contents either by flooding it
            // with the optional background colour, or by clearing all pixel content

            if ( this._bgColor ) {
                ctx.fillStyle = this._bgColor;
                ctx.fillRect( 0, 0, width, height );
            }
            else {
                ctx.clearRect( 0, 0, width, height );
            }

            const useExternalUpdateHandler = typeof this._updateHandler === "function";

            if ( useExternalUpdateHandler ) {
                this._updateHandler( now );
            }

            // draw the children onto the canvas

            theSprite = this._children[ 0 ];

            while ( theSprite ) {

                if ( !useExternalUpdateHandler ) {
                    theSprite.update( now );
                }
                theSprite.draw( ctx, viewport );
                theSprite = theSprite.next;
            }
        }

        // keep render loop going if Canvas is animatable

        if ( !this._disposed && this._animate && !this._renderPending ) {
            this._renderPending = true;
            this._renderId = window.requestAnimationFrame( this._renderHandler );
        }
    }

    handleInteraction( aEvent ) {
        const numChildren = this._children.length;
        const viewport    = this._viewport;
        let theChild, touches, found;

        if ( numChildren > 0 ) {

            // reverse loop to first handle top layers
            theChild = this._children[ numChildren - 1 ];

            switch ( aEvent.type ) {

                // all touch events
                default:
                    let eventOffsetX = 0, eventOffsetY = 0;
                    touches /** @type {TouchList} */ = ( aEvent.touches.length > 0 ) ? aEvent.touches : aEvent.changedTouches;

                    if ( touches.length > 0 ) {
                        const offset = this.getCoordinate();
                        if ( viewport ) {
                            offset.x -= viewport.left;
                            offset.y -= viewport.top;
                        }
                        eventOffsetX = ( touches[ 0 ].pageX - offset.x ) / this.zoomFactor ; // QQQ
                        eventOffsetY = ( touches[ 0 ].pageY - offset.y ) / this.zoomFactor; // QQQ
                    }

                    while ( theChild ) {
                        theChild.handleInteraction( eventOffsetX, eventOffsetY, aEvent );
                        theChild = theChild.last; // note we don't break this loop for multi touch purposes
                    }
                    break;

                // all mouse events
                case "mousedown":
                case "mousemove":
                case "mouseup":
                    let { offsetX, offsetY } = aEvent;
                    if ( viewport ) {
                        offsetX += viewport.left;
                        offsetY += viewport.top;
                    }
                    offsetX /= this.zoomFactor; // QQQ
                    offsetY /= this.zoomFactor; // QQQ
                    while ( theChild ) {
                        found = theChild.handleInteraction( offsetX, offsetY, aEvent );
                        if ( found ) {
                            break;
                        }
                        theChild = theChild.last;
                    }
                    break;

                // scroll wheel
                case "wheel":
                    const { deltaX, deltaY } = aEvent;
                    const WHEEL_SPEED = 20;
                    const xSpeed = deltaX === 0 ? 0 : deltaX > 0 ? WHEEL_SPEED : -WHEEL_SPEED;
                    const ySpeed = deltaY === 0 ? 0 : deltaY > 0 ? WHEEL_SPEED : -WHEEL_SPEED;
                    this.panViewport( viewport.left + xSpeed, viewport.top + ySpeed, true );
                    break;
            }
        }
        if ( this._preventDefaults ) {
            aEvent.stopPropagation();
            aEvent.preventDefault();
        }
        // update the Canvas contents
        this.invalidate();
    }
}
export default ZoomableCanvas;
