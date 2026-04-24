/*  Copyright 2007, 2008, 2009, 2026 Roy Arends

    This file is part of 3DHeatMap.

    3DHeatMap is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    3DHeatMap is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with 3DHeatMap.  If not, see <http://www.gnu.org/licenses/>.

*/

#include <arpa/inet.h>
#include <err.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#ifdef __APPLE__
#include <OpenGL/gl.h>
#include <OpenGL/glu.h>
#include <GLUT/glut.h>
#else
#include <GL/gl.h>
#include <GL/glu.h>
#include <GL/glut.h>
#endif

#define MAX_POINTS 2000000
#define MAX_ADDRESS 0xFFFFFFFF
#define VERSION "1.0"
#define FALSE 0
#define TRUE !FALSE

typedef unsigned char bool;

static bool blend = TRUE, fullscreen = FALSE, focus = FALSE, showaxis = FALSE,
            showcube = TRUE, showhelp = TRUE, showtext = TRUE, showincube = FALSE;

static unsigned int numpoints = 0, netblock = (10 << 24), cidr = 8, colormap = 0;

static int treslow = 7, treshigh = 255, moving = 0, beginx = 0, beginy = 0;

static GLfloat xrot = 0.0, yrot = 0.0, autoxrot = 0.0, autoyrot = 0.0,
               mouse_accel = 0.15, rotinc = 3.0, autoinc = 0.3,
               pointsize = 1.0, defpointsize = 1.0, alpha = 0.5, zoom = 1.0;

static int w = 640, h = 480;

static float fps = 0.0;

static int frame = 0, time = 0, timebase = 0;

const char *mapname = NULL;
static void *font = NULL;

static GLfloat colors[3][256][4];

static FILE *mapfp = NULL;
static int reading_done = 0;
static char buffer[80];
static unsigned int ReverseList[256][256][256];

typedef struct {
    GLshort coord[3];
    uint8_t frequency;
} Cocol;

typedef struct {
    unsigned int p0;
    unsigned int p1;
} Poffset;

static Cocol plist[MAX_POINTS];
static Poffset offsets[256];

static inline uint32_t compact1by2(uint32_t x){
    x &= 0x09249249u;                   
    x = (x ^ (x >> 2))  & 0x030c30c3u;
    x = (x ^ (x >> 4))  & 0x0300f00fu;
    x = (x ^ (x >> 8))  & 0xff0000ffu;
    x = (x ^ (x >> 16)) & 0x000003ffu;  
    return x;
}

static inline void mor_xyz_from_s(unsigned int s, short *xp, short *yp, short *zp){
    uint32_t v = (uint32_t)s;
    uint32_t x = compact1by2(v >> 0);
    uint32_t y = compact1by2(v >> 1);
    uint32_t z = compact1by2(v >> 2);
    *xp = (short)(x & 0xFFu);
    *yp = (short)(y & 0xFFu);
    *zp = (short)(z & 0xFFu);
}

void mor_s_from_xyz(unsigned int *sp, short x, short y, short z){
    short i = 7;
    unsigned int s = 0;
    for (; i >= 0; i--){
        s = (s << 1) | ((z >> i) & 1);
        s = (s << 1) | ((y >> i) & 1);
        s = (s << 1) | ((x >> i) & 1);
    }
    *sp = s << 8;
}

void half_netblock_size(unsigned int cidr, short *xp, short *yp, short *zp){
    short x, y, z;
    mor_xyz_from_s((MAX_ADDRESS >> cidr) >> 8, &x, &y, &z);
    *xp = x / 2;
    *yp = y / 2;
    *zp = z / 2;
}


static inline void rgb_from_h(float h, float *r, float *g, float *b){
    h = fmodf(h, 360.0f);
    if (h < 0.0f) h += 360.0f;

    float hf = h * (1.0f / 60.0f);
    int i = (int)hf;          // 0..5
    float f = hf - i;

    switch (i){
    case 0: *r = 1.0f;     *g = f;        *b = 0.0f;     break;
    case 1: *r = 1.0f - f; *g = 1.0f;     *b = 0.0f;     break;
    case 2: *r = 0.0f;     *g = 1.0f;     *b = f;        break;
    case 3: *r = 0.0f;     *g = 1.0f - f; *b = 1.0f;     break;
    case 4: *r = f;        *g = 0.0f;     *b = 1.0f;     break;
    default:*r = 1.0f;     *g = 0.0f;     *b = 1.0f - f; break; // i==5
    }
}

static inline float clampDegrees(float in){
    in = fmodf(in, 360.0f);
    if (in < 0.0f) in += 360.0f;
    return in;
}

static void sortPointList(void){
    unsigned int hist[256] = {0};
    unsigned int start[256];
    unsigned int sum = 0;
    for (unsigned int i = 0; i < numpoints; ++i) hist[plist[i].frequency]++;
    for (unsigned int f = 0; f < 256; ++f){
        offsets[f].p0 = sum;
        sum += hist[f];
        offsets[f].p1 = sum;
        start[f] = offsets[f].p0; // running write cursor
    }
    static Cocol *tmp = NULL;
    static unsigned int tmp_cap = 0;
    if (tmp_cap < numpoints){
        free(tmp);
        tmp = malloc(sizeof(Cocol) * numpoints);
        if (!tmp) errx(1, "oom");
        tmp_cap = numpoints;
    }

    for (unsigned int i = 0; i < numpoints; ++i){
        unsigned int f = plist[i].frequency;
        tmp[start[f]++] = plist[i];
    }
    memcpy(plist, tmp, sizeof(Cocol) * numpoints);
}

void makeColorList(void){
    int i;
    GLfloat r, g, b;
    for (i = 0; i < 256; i++){
        rgb_from_h(0.9375 * (255 - i), &r, &g, &b);
        colors[0][i][0] = r;
        colors[0][i][1] = g;
        colors[0][i][2] = b;
        rgb_from_h((int)(240 + 0.703125 * i) % 360, &r, &g, &b);
        colors[1][i][0] = r;
        colors[1][i][1] = g;
        colors[1][i][2] = b;
        rgb_from_h(0.9375 * i, &r, &g, &b);
        colors[2][i][0] = r;
        colors[2][i][1] = g;
        colors[2][i][2] = b;
    }
}

void set2DMode(void){
    glMatrixMode(GL_PROJECTION);
    glLoadIdentity();
    glOrtho(0, w, h, 0, -1, 1);

    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
}

void set3DMode(void){
    glMatrixMode(GL_PROJECTION);
    glLoadIdentity();
    gluPerspective(50.0, (float)w / h, 1, 1024);
    gluLookAt(0, 0, 400, 0, 0, 0, 0.0, 1.0, 0.0);

    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
}

static inline void drawStr(int x, int y, const char *str){
    if (!str) return;
    if (y < 0) y += h;

    glRasterPos2i(x, y);
    for (const unsigned char *p = (const unsigned char *)str; *p; ++p)
        glutBitmapCharacter(font, *p);
}

void drawAxis(void){
    glBegin(GL_LINES);
    glColor4f(1, 0, 1, 1);
    glVertex3i(128, 128, 0);
    glVertex3i(128, 128, 256);
    glVertex3i(128, 0, 128);
    glVertex3i(128, 256, 128);
    glVertex3i(0, 128, 128);
    glVertex3i(256, 128, 128);
    glEnd();
    glColor3f(1, 1, 1);
    glRasterPos3f(128, 128, -13);
    glutBitmapCharacter(GLUT_BITMAP_8_BY_13, 'z');
    glRasterPos3f(128, -13, 128);
    glutBitmapCharacter(GLUT_BITMAP_8_BY_13, 'y');
    glRasterPos3f(269, 128, 128);
    glutBitmapCharacter(GLUT_BITMAP_8_BY_13, 'x');
}

void drawCube(unsigned int s, unsigned int bits){
    int i, c, index;
    GLfloat v[8][3];
    GLshort x, y, z;
    GLint sides[6][4] = {
        {0, 1, 2, 3}, {3, 2, 6, 7}, {7, 6, 5, 4},
        {4, 5, 1, 0}, {5, 6, 2, 1}, {7, 4, 0, 3}};
    mor_xyz_from_s(s >> 8, &x, &y, &z);
    v[0][0] = v[3][0] = v[4][0] = v[7][0] = x;
    v[0][1] = v[1][1] = v[4][1] = v[5][1] = y;
    v[0][2] = v[1][2] = v[2][2] = v[3][2] = z;
    mor_xyz_from_s((s + (MAX_ADDRESS >> bits)) >> 8, &x, &y, &z);
    v[1][0] = v[2][0] = v[5][0] = v[6][0] = x;
    v[2][1] = v[3][1] = v[6][1] = v[7][1] = y;
    v[4][2] = v[5][2] = v[6][2] = v[7][2] = z;
    for (i = 0; i < 6; i++){
        glBegin(GL_QUADS);
        for (c = 0; c < 4; c++){
            index = sides[i][c] * 40 + 15;
            colors[colormap][index][3] =
                alpha + (1.0 - alpha) * (index / 255.0);
            glColor4fv(colors[colormap][index]);
            glVertex3fv(&v[sides[i][c]][0]);
        }
        glEnd();
    }
}

void drawText(void){
    char dotted_quad[17], buffer[80];
    unsigned int address;
    font = GLUT_BITMAP_HELVETICA_10;
    glColor3f(0.7, 0.7, 0.7);
    address = htonl(netblock);
    inet_ntop(AF_INET, &address, dotted_quad, 17);
    sprintf(buffer, "netblock:     %s / %d", dotted_quad, cidr);
    drawStr(5, -3, buffer);
    sprintf(buffer, "Ypos: %d", (int)yrot);
    drawStr(5, -18, buffer);
    sprintf(buffer, "Xpos: %d", (int)xrot);
    drawStr(5, -33, buffer);
    sprintf(buffer, "Threshold:    %d, %d", treslow, treshigh);
    drawStr(5, -48, buffer);
    sprintf(buffer, "point/scale:    %1.1f / %1.1f", pointsize, defpointsize);
    drawStr(5, -63, buffer);
    sprintf(buffer, "transparency: %1.2f", alpha);
    drawStr(5, -78, buffer);
    sprintf(buffer, "viewmode: %s, %s", showincube ? "cube" : "total",
            focus ? "focus" : "travel");
    drawStr(5, -93, buffer);
    sprintf(buffer, "Color map: %s",
            (colormap == 0) ? "GOBI" : (colormap == 1) ? "LUNA" : "INTI");
    drawStr(5, -108, buffer);
    sprintf(buffer, "FPS: %.1f", fps);
    drawStr(5, -123, buffer);
}

void drawCopyright(void){
    char dotted_quad[17], buffer[80];
    unsigned int address;
    font = GLUT_BITMAP_HELVETICA_10;

    glColor3f(0.7, 0.7, 0.7);
    address = htonl(netblock);
    inet_ntop(AF_INET, &address, dotted_quad, 17);
    sprintf(buffer, "netblock:     %s / %d", dotted_quad, cidr);
    drawStr(5, -3, buffer);
    drawStr(5, 15, "3D IPv4 Heatmap / Roy Arends");
}

void showHelp(void){
    font = GLUT_BITMAP_9_BY_15;
    glColor3f(0.8, 0.8, 0.8);
    drawStr(30, 100, "3D view control                  Pixel and Color control");
    glColor3f(0.5, 0.5, 0.5);
    drawStr(30, 115, "X   Rotate around X axis         1/2/3 color maps");
    drawStr(30, 130, "Y   Rotate around Y axis         T     transparency");
    drawStr(30, 145, "L/K Autorotate around X/Y axis   P/U   pixel/scale size");
    drawStr(30, 160, "A   show axis                    B     blend on/off");
    drawStr(30, 175, "F   Focus                        +/-   Zoom In/Out");
    glColor3f(0.8, 0.8, 0.8);
    drawStr(30, 205, "Cube Cursor Control              Threshold Selection");
    glColor3f(0.5, 0.5, 0.5);
    drawStr(30, 220, "C   en/disable cube cursor       H     color Threshold");
    drawStr(30, 235, "S   cursor (cidr) size           M     color Max");
    drawStr(30, 250, "</> netblock address             I     color Slider");
    drawStr(30, 265, "arrow/page   move cursor");
    drawStr(30, 280, "[enter] view selection           use Mouse to rotate view");
    drawStr(30, 310, "F1  this help message            F2    show text");
    drawStr(30, 325, "[ESC] to exit");
}

void readNextPoints(void){
    if (reading_done) return;
    int batch = 1000;

    while (batch-- && fgets(buffer, sizeof(buffer), mapfp)){

        char *dq = buffer;

        while (*dq==' '||*dq=='\t'||*dq=='\r'||*dq=='\n') dq++;
        if (*dq=='\0') continue;

        char *end = dq;
        while (*end && *end!=' ' && *end!='\t' && *end!='\r' && *end!='\n') end++;
        *end = '\0';

        unsigned int s;
        GLshort x,y,z;

        if (inet_pton(AF_INET, dq, &s)==1) mor_xyz_from_s(ntohl(s)>>8,&x,&y,&z);
        else continue;

        unsigned int *rp = &ReverseList[(uint8_t)x][(uint8_t)y][(uint8_t)z];

        if (*rp == 0){
            if (numpoints >= MAX_POINTS){
                 errx(1, "too many points (>%u). Increase MAX_POINTS.", MAX_POINTS);
            }

            plist[numpoints].frequency = 0;
            plist[numpoints].coord[0] = x;
            plist[numpoints].coord[1] = y;
            plist[numpoints].coord[2] = z;

            *rp = numpoints + 1;     /* store index+1 (0 means empty) */
            numpoints++;
        } else {
            plist[*rp - 1].frequency++;
        }
    }

    if (feof(mapfp)){
        fclose(mapfp);
        reading_done = 1;
        sortPointList();
    }
}


void cb_Idle(void){
    readNextPoints();
    static int last_time = 0;
    int now = glutGet(GLUT_ELAPSED_TIME);

    if (last_time == 0) last_time = now;

    int dt_ms = now - last_time;
    last_time = now;

    // FPS counter (unchanged logic, but keep it independent)
    frame++;
    time = now;
    if ((time - timebase) > 1000){
        fps = frame * 1000.0f / (time - timebase);
        timebase = time;
        frame = 0;
    }

    if ((fabs(autoxrot) > 1E-3) || (fabs(autoyrot) > 1E-3)){
        float dt = dt_ms * 0.001f; // seconds
        yrot += autoxrot * dt;
        xrot += autoyrot * dt;

        glutPostRedisplay();
    } else {
        static int last_beat = 0;
        if (now - last_beat > 250){
            last_beat = now;
            glutPostRedisplay();
        }
    }
}

void cb_Display(void){
    int i;
    GLshort color;
    GLshort vx, vy, vz, x1, x2, y1, y2, z1, z2;
    GLdouble clip[6][4] = {
        {+1, 0, 0, 0}, {-1, 0, 0, 0}, {0, +1, 0, 0},
        {0, -1, 0, 0}, {0, 0, +1, 0}, {0, 0, -1, 0},
    };

    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

    if (blend) glEnable(GL_BLEND);
    else glDisable(GL_BLEND);

    set3DMode();

    xrot = clampDegrees(xrot);
    yrot = clampDegrees(yrot);

    glRotatef(xrot, 1, 0, 0);
    glRotatef(yrot, 0, 1, 0);
    glScalef(zoom, -zoom, -zoom);

    mor_xyz_from_s(netblock >> 8, &x1, &y1, &z1);
    mor_xyz_from_s((netblock + (MAX_ADDRESS >> cidr)) >> 8, &x2, &y2, &z2);

    half_netblock_size(focus ? cidr : 0, &vx, &vy, &vz);
    glTranslated(-vx, -vy, -vz);
    if (focus)  glTranslated(-x1, -y1, -z1);

    if (showincube){
        clip[0][3] = -x1 + 0.5;
        clip[1][3] = x2 + 0.5;
        clip[2][3] = -y1 + 0.5;
        clip[3][3] = y2 + 0.5;
        clip[4][3] = -z1 + 0.5;
        clip[5][3] = z2 + 0.5;

        for (i = 0; i < 6; ++i){
            glClipPlane(GL_CLIP_PLANE0 + i, clip[i]);
            glEnable(GL_CLIP_PLANE0 + i);
        }
    }

    if (!reading_done){
        glPointSize(pointsize < 1.0f ? 1.0f : pointsize);

        if (numpoints > 0){
            glBegin(GL_POINTS);
            for (unsigned int p = 0; p < numpoints; ++p){
                uint8_t f = plist[p].frequency;
                if (f < treslow || f >= treshigh) continue;
                colors[colormap][f][3] = alpha + (1.0f - alpha) * (f / 255.0f);
                glColor4fv(colors[colormap][f]);
                glVertex3sv(plist[p].coord);
            }
            glEnd();
        }
    } else {
        glEnableClientState(GL_VERTEX_ARRAY);
        glVertexPointer(3, GL_SHORT, sizeof(Cocol), &plist[0].coord[0]);
        float last_ps = -1.0f;
        for (color = treslow; color < treshigh; ++color){
            unsigned int p0 = offsets[color].p0;
            unsigned int p1 = offsets[color].p1;

            if (p1 <= p0) continue;
            float ps = pointsize + (defpointsize * color / 256.0f);
            if (ps < 1.0f) ps = 1.0f;
            if (ps != last_ps){
                 glPointSize(ps);
                 last_ps = ps;
            }

            colors[colormap][color][3] = alpha + (1.0f - alpha) * (color / 255.0f);
            glColor4fv(colors[colormap][color]);
            glDrawArrays(GL_POINTS, (GLint)p0, (GLsizei)(p1 - p0));
        }
        glDisableClientState(GL_VERTEX_ARRAY);
    }

    if (showincube){
        for (i = 0; i < 6; ++i) glDisable(GL_CLIP_PLANE0 + i);
    }

    if (showaxis) drawAxis();
    if (showcube) drawCube(netblock, cidr);
    set2DMode();
    if (showtext) drawText();
    if (showhelp) showHelp();
    drawCopyright();
    glutSwapBuffers();
}

void cb_Mouse(int button, int state, int x, int y){
    if (state == GLUT_DOWN){
        moving = button;
        beginx = x;
        beginy = y;
    } else moving = 0;
}

void cb_Motion(int x, int y){
    if (moving == GLUT_LEFT_BUTTON){
        yrot += mouse_accel * (x - beginx);
        xrot += mouse_accel * (y - beginy);
        beginx = x;
        beginy = y;
        glutPostRedisplay();
    }
}

void cb_Reshape(int nw, int nh){
    w = nw;
    h = nh;
    if (!h) h = 1;
    glViewport(0, 0, w, h);
}

void resetGL(void){
    xrot = yrot = autoxrot = autoyrot = 0.0;
    blend = TRUE;
}

void cb_SpecialKey(int c, int x, int y){
    (void)x;
    (void)y;
    static GLshort cube_x, cube_y, cube_z;
    int tmp;
    mor_xyz_from_s(netblock >> 8, &cube_x, &cube_y, &cube_z);
    int sx = 2 << ((23 - cidr) / 3);
    int sy = 2 << ((22 - cidr) / 3);
    int sz = 2 << ((21 - cidr) / 3);
    switch (c){
    case GLUT_KEY_LEFT:
        if (cube_x > 0) cube_x -= sx;
        break;
    case GLUT_KEY_RIGHT:
        tmp = cube_x;
        cube_x += sx;
        if (cube_x > 255) cube_x = tmp;
        break;
    case GLUT_KEY_UP:
        if (cube_y > 0) cube_y -= sy;
        break;
    case GLUT_KEY_DOWN:
        tmp = cube_y;
        cube_y += sy;
        if (cube_y > 255) cube_y = tmp;
        break;
    case GLUT_KEY_PAGE_UP:
        if (cube_z > 0) cube_z -= sz;
        break;
    case GLUT_KEY_PAGE_DOWN:
        tmp = cube_z;
        cube_z += sz;
        if (cube_z > 255) cube_z = tmp;
        break;
    case GLUT_KEY_F1:
        showhelp = !showhelp;
        break;
    case GLUT_KEY_F2:
        showtext = !showtext;
        break;
    }
    mor_s_from_xyz(&netblock, cube_x, cube_y, cube_z);
    netblock &= (MAX_ADDRESS << (32 - cidr));
    glutPostRedisplay();
}

void cb_Key(unsigned char c, int x, int y){
    (void)x;
    (void)y;
    switch (c){
    case 'x':
        xrot += rotinc;
        break;
    case 'X':
        xrot -= rotinc;
        break;
    case 'y':
        yrot += rotinc;
        break;
    case 'Y':
        yrot -= rotinc;
        break;
    case 'u':
        defpointsize += 0.1;
        break;
    case 'U':
        defpointsize -= 0.1;
        break;
    case 'p':
        pointsize += 0.1;
        break;
    case 'P':
        pointsize -= 0.1;
        break;
    case ' ':
        resetGL();
        break;
    case '1':
        colormap = 0;
        break;
    case '2':
        colormap = 1;
        break;
    case '3':
        colormap = 2;
        break;
    case 'c':
    case 'C':
        showcube = !showcube;
        break;
    case 'f':
    case 'F':
        focus = !focus;
        break;
    case 'a':
    case 'A':
        showaxis = !showaxis;
        break;
    case 'l':
        autoxrot += autoinc;
        break;
    case 'L':
        autoxrot -= autoinc;
        break;
    case 'k':
        autoyrot += autoinc;
        break;
    case 'K':
        autoyrot -= autoinc;
        break;
    case '+':
        zoom += 0.1;
        break;
    case '-':
        zoom -= 0.1;
        break;
    case 'b':
    case 'B':
        blend = !blend;
        break;
    case 'h':
        if (treslow < treshigh) treslow++;
        break;
    case 'H':
        if (treslow) treslow--;
        break;
    case 'm':
        if (treshigh < 255) treshigh++;
        break;
    case 'M':
        if (treshigh > treslow) treshigh--;
        break;
    case 'i':
        if (treshigh < 255){
            treshigh++;
            treslow++;
        }
        break;
    case 'I':
        if (treslow){
            treslow--;
            treshigh--;
        }
        break;
    case 't':
        if (alpha < 1.0) alpha += 0.01;
        break;
    case 'T':
        if (alpha > 0.1) alpha -= 0.01;
        break;
    case '<':
        if (netblock){
            netblock = netblock >> (32 - cidr);
            netblock--;
            netblock = netblock << (32 - cidr);
        }
        break;
    case '>':
        netblock = netblock >> (32 - cidr);
        if (netblock < (MAX_ADDRESS >> (32 - cidr))) netblock++;
        netblock = netblock << (32 - cidr);
        break;
    case 'S':
        if (cidr > 0){
            cidr--;
            if (cidr) netblock &= MAX_ADDRESS << (32 - cidr);
            else netblock = 0;
        }
        break;
    case 's':
        if (cidr < 24){
            cidr++;
            netblock &= MAX_ADDRESS << (32 - cidr);
        }
        break;
    case 13:
        showincube = !showincube;
        break;
    case 27:
        exit(0);
    default:
        return;
    }
    glutPostRedisplay();
}

void Usage(void){
    printf("IPv4 3D Heatmap (C) 2007-2026 Roy Arends \n");
    printf("Version %s\n\n", VERSION);
    printf("usage: 3dheatmap [-f] -m iplist\n");
    printf("\t-f            Fullscreen\n");
    printf("\t-m filename   Filename of the iplist\n");
    exit(1);
}

int main(int argc, char *argv[]){
    int cmd_option;
    while ((cmd_option = getopt(argc, argv, "fm:")) != -1){
        switch (cmd_option){
            case 'f':
                fullscreen = 1;
                break;
            case 'm':
                mapname = strdup(optarg);
                break;
            default:
                Usage();
        }
    }
    if (mapname == NULL) Usage();
    makeColorList();
    glutInit(&argc, argv);
    glutInitWindowSize(2880, 1800);
    glutInitDisplayMode(GLUT_RGB | GLUT_DOUBLE | GLUT_DEPTH | GLUT_MULTISAMPLE);
    glutCreateWindow("3D IPv4 HeatMap");
    mapfp = fopen(mapname, "r");
    if (!mapfp) err(1, "%s", mapname);
    if (fullscreen)  glutFullScreen();
    glutDisplayFunc(cb_Display);
    glutMouseFunc(cb_Mouse);
    glutMotionFunc(cb_Motion);
    glutKeyboardFunc(cb_Key);
    glutSpecialFunc(cb_SpecialKey);
    glutReshapeFunc(cb_Reshape);
    glutIdleFunc(cb_Idle);
    glutSetCursor(GLUT_CURSOR_INFO);
    glHint(GL_PERSPECTIVE_CORRECTION_HINT, GL_NICEST);
    glEnable(GL_DEPTH_TEST);
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glutMainLoop();
    return 0;
}
